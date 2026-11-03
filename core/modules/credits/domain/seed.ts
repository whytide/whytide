// The seeder and the period grants (README "The seeder", docs/security.md). seed() writes the fixed
// plan from the settings, then grants the current period to every organization with an active
// subscription, on a billing_writer client: the api host awaits onStart() before it listens, and
// `pnpm credits:seed` runs it by hand. onStart() also binds the credits client and writes the price
// list (prices.ts). seedOrganization() is the event handler's call for a new organization, as `app`,
// and grantPeriods() the worker's daily pass, as `app` too. All grant through
// credits_seed_self_hosted, the migration's function, which grants a period once.
import { createDbClient, type PrismaClient, type TenantClient } from "@whytide/db";
import { bindCreditsClient, type Logger, newId, registeredPrices } from "@whytide/platform";
import { ids } from "../ids.ts";
import { settings } from "../settings.ts";
import { creditsClient } from "./client.ts";
import { periodFor } from "./period.ts";
import { assemblePrices, syncPrices } from "./prices.ts";
import { inGlobal } from "./store.ts";

export type SeedSettings = {
  readonly CREDITS_MONTHLY_ALLOWANCE: number;
  readonly CREDITS_PLAN_CODE: string;
};

/** The fixed plan, created or updated with the allowance; any other plan stops being the fixed one. */
export function seedPlan(client: PrismaClient, config: SeedSettings) {
  const code = config.CREDITS_PLAN_CODE;
  const monthlyAllowance = config.CREDITS_MONTHLY_ALLOWANCE;
  return client.$transaction(async (tx) => {
    const plan = await tx.plan.upsert({
      where: { code },
      create: { id: newId(ids.plan), code, name: code, monthlyAllowance, isFixed: true },
      update: { monthlyAllowance, isFixed: true },
    });
    const others = { isFixed: true, id: { not: plan.id } };
    await tx.plan.updateMany({ where: others, data: { isFixed: false } });
    return plan;
  });
}

/** The organization's subscription and its grant for the current period; true when this call granted. */
export async function seedOrganization(
  db: Pick<PrismaClient, "$queryRaw">,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db.$queryRaw<{ granted: boolean }[]>`
    SELECT credits_seed_self_hosted(${organizationId}) AS granted`;
  return row?.granted === true;
}

/** The organizations with a subscription, the oldest first. */
const subscribed = (db: Pick<TenantClient, "subscription">) =>
  db.subscription.findMany({
    select: { organizationId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

/** One call per organization, so that a failure undoes no grant made before it; how many granted. */
async function grantEach(
  db: Pick<PrismaClient, "$queryRaw">,
  organizations: readonly { organizationId: string }[],
): Promise<number> {
  let granted = 0;
  for (const { organizationId } of organizations) {
    if (await seedOrganization(db, organizationId)) granted += 1;
  }
  return granted;
}

/**
 * The current period for every organization with a subscription; how many were granted now. A
 * subscription that is not active gets none (credits_seed_self_hosted).
 */
export async function renewPeriods(client: PrismaClient): Promise<number> {
  return grantEach(client, await subscribed(client));
}

/**
 * The worker's daily pass (workflows/index.ts, credits_period): renewPeriods as `app`, in
 * withoutTenant("credits.period"); the organizations seen and how many were granted now.
 */
export function grantPeriods(): Promise<{ organizations: number; granted: number }> {
  return inGlobal("period", async (db, app) => {
    const organizations = await subscribed(db);
    return { organizations: organizations.length, granted: await grantEach(app, organizations) };
  });
}

/** The plan, then the periods, on the billing_writer client given. */
export async function seed(client: PrismaClient, log: Logger, config: SeedSettings = settings) {
  const plan = await seedPlan(client, config);
  const granted = await renewPeriods(client);
  const fields = {
    plan_id: plan.id,
    granted_count: granted,
    period_start_at: periodFor(new Date()).start.toISOString(),
  };
  log.info(fields, "credits: the plan and the periods are seeded");
}

/**
 * The api host's start hook: binds the credits client, then the seeder and the price list, the
 * prices the loaded modules declare with their PRICE_<ACTION> overrides, as billing_writer on a
 * client closed when it is done. A malformed override stops the start before anything is written.
 */
export async function onStart({ log }: { readonly log: Logger }): Promise<void> {
  bindCreditsClient(creditsClient);
  const prices = assemblePrices(registeredPrices().values(), process.env);
  const client = createDbClient("billing_writer");
  try {
    await seed(client, log);
    await syncPrices(client, prices, log);
  } finally {
    await client.$disconnect();
  }
}

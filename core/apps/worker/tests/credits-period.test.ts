// credits_period (core/modules/credits README "Periods"), on the slice's Temporal and a schema of its
// database: credits' registrations loaded from its build as the worker loads them, its activity
// through the host's wrapper as `app`, which reads subscriptions and executes
// credits_seed_self_hosted with the grants of credits' migrations. An organization a period behind
// is granted the current one and its balance moves; a second run grants nothing; a cancelled
// subscription gets nothing; the counts only are logged. Two starts leave one credits.period
// schedule. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ids, periodFor } from "@whytide/credits";
import { useCreditsClient } from "@whytide/credits/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, newId } from "@whytide/platform";
import { hostActivity } from "../src/activities.ts";
import { moduleLoaders } from "../src/modules.generated.ts";
import { loadModules, startModules } from "../src/modules.ts";
import { start } from "../src/start.ts";
import { runWorkflow, withTestWorkflowEnvironment } from "../testing/index.ts";

withTestDb();
const env = withTestWorkflowEnvironment();
useCreditsClient(asRole("app"));
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const credits = moduleLoaders.filter(({ name }) => name === "credits");
const loaded = await loadModules(credits);
await startModules(loaded, log);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: asRole("app"), log })];
  }),
);

/** The organization's subscription and grant of the last period, as the seeder wrote them then. */
async function subscribedLastPeriod(organizationId: string, status: "active" | "cancelled") {
  const billing = asRole("billing_writer");
  const code = "self_hosted";
  const plan = await billing.plan.upsert({
    where: { code },
    create: { id: newId(ids.plan), code, name: code, monthlyAllowance: 100, isFixed: true },
    update: {},
  });
  const last = periodFor(new Date(periodFor(new Date()).start.getTime() - 1));
  const period = { organizationId, periodStart: last.start, periodEnd: last.end };
  const { id } = await billing.subscription.create({
    data: { ...period, id: newId(ids.subscription), planId: plan.id, status },
  });
  const grant = {
    id: newId(ids.credit_grant),
    subscriptionId: id,
    amount: 100,
    reason: "allowance",
  };
  await billing.creditGrant.create({ data: { ...period, ...grant } });
}

test("credits_period grants an organization a period behind once and its balance moves; a second run grants nothing; a cancelled subscription gets nothing", async () => {
  await subscribedLastPeriod("org_behind", "active");
  await subscribedLastPeriod("org_cancelled", "cancelled");
  const run = () => runWorkflow("credits_period", {}, { activities });
  const granted = async () => {
    const rows = await asRole("app").creditBalance.findMany();
    return Object.fromEntries(rows.map((row) => [row.organizationId, row.granted.toString()]));
  };
  assert.deepEqual(await granted(), { org_behind: "100", org_cancelled: "100" });
  assert.deepEqual(await run(), { organizations: 2, granted: 1 });
  assert.deepEqual(await granted(), { org_behind: "200", org_cancelled: "100" });
  assert.deepEqual(await run(), { organizations: 2, granted: 0 });
  assert.deepEqual(await granted(), { org_behind: "200", org_cancelled: "100" });
  const lines = logs.lines().filter(({ msg }) => msg === "credits: the periods are granted");
  const seen = lines.map(({ organization_count, granted_count, actor, workspace_id }) => {
    return { organization_count, granted_count, actor, workspace_id };
  });
  const counts = { organization_count: 2, actor: "service:worker", workspace_id: undefined };
  assert.deepEqual(seen, [
    { ...counts, granted_count: 1 },
    { ...counts, granted_count: 0 },
  ]);
});

test("two starts of the worker leave one credits.period schedule, by its id, daily at 00:05 UTC", async () => {
  const handle = env.client.schedule.getHandle("credits.period");
  const own = { modules: credits, taskQueue: env.taskQueue, client: asRole("app"), log };
  const options = { ...own, healthPort: 0, schedules: "off" } as const;
  await handle.delete().catch(() => undefined);
  try {
    await (await start(options)).close();
    const created = await handle.describe();
    await (await start(options)).close();
    const described = await handle.describe();
    assert.deepEqual(described.info.createdAt, created.info.createdAt);
    assert.equal(described.action.workflowType, "credits_period");
    const [daily] = described.spec.calendars ?? [];
    const at = (range = [{ start: -1 }]) => range.map(({ start }) => start);
    assert.deepEqual(
      [at(daily?.hour), at(daily?.minute), described.spec.timezone],
      [[0], [5], "UTC"],
    );
  } finally {
    await handle.delete().catch(() => undefined);
  }
});

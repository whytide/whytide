// credits' prices route and its usage rows' version end to end (gamma-p2-060;
// core/modules/credits/README.md "Showing a price"): the host started with identity and credits
// without its onStart, as credits-balance.test.ts starts it; the price list written by credits'
// syncPrices as billing_writer at instants before the request's, since the route reads the clock.
// Every action of the version in effect, `next` null without a pending version, `next` with its date
// and announcement during a notice and null again once the rise is set back; each usage row's
// priceListVersion, the reserve's; credits.read required. On the fake authentication adapter, in a
// schema of the worktree's database.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, newId, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, createUser, useTenancyClient } from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// credits by its build's path, as src/modules.generated.ts loads it (credits-balance.test.ts).
const build = new URL("../../../../modules/credits/dist/", import.meta.url);
type Credits = typeof import("../../../modules/credits/dist/index.js");
type CreditsTesting = typeof import("../../../modules/credits/dist/testing/index.js");
const credits: Credits = await import(new URL("index.js", build).href);
const { createCreditsClient, grantAllowance, syncPrices }: CreditsTesting = await import(
  new URL("testing/index.js", build).href
);

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
const log = createLogger({ destination: collectLogs().destination });
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  const { onStart: _seeder, ...withoutSeeder } = credits;
  api = await start({
    port: 0,
    log,
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "credits", load: async () => withoutSeeder },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

/** GET /v1/workspaces/<workspace>/credits/<path>, signed in as the user. */
async function get(userId: string, workspace: string, path: string) {
  const cookie = signInAs(userId).map(({ name, value }) => `${name}=${value}`);
  const url = new URL(`/v1/workspaces/${workspace}/credits/${path}`, api.url);
  const res = await fetch(url, { headers: { cookie: cookie.join("; ") } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The price list as the seeder writes it at `at`: "action credits unit" each. */
const writePrices = (at: Date, ...entries: string[]) => {
  const list = entries.map((entry) => {
    const [action = "", credits = "", unit = ""] = entry.split(" ");
    return { action, credits, unit };
  });
  return syncPrices(asRole("billing_writer"), list, log, at);
};
/** An instant `ms` before the request's. */
const ago = (ms: number) => new Date(Date.now() - ms);
/** The date a rise announced at `at` takes effect. */
const dateOf = (at: Date) => {
  const date = new Date(at);
  date.setUTCDate(date.getUTCDate() + credits.settings.CREDITS_PRICE_CHANGE_NOTICE_DAYS);
  return date;
};

test("GET …/credits/prices: every action of the version in effect, by action, with its credits, unit, version and date; next null without a pending version", async () => {
  const [a] = await createTwoWorkspaces();
  const first = ago(120_000);
  await writePrices(first, "test.b 0.5 profile", "test.a 1 call");
  const dropped = ago(60_000);
  await writePrices(dropped, "test.b 0.25 profile", "test.a 1 call");
  const effectiveFrom = dropped.toISOString();
  const price = (action: string, credits: string, unit: string) => {
    return { action, credits, unit, version: 2, effectiveFrom, next: null };
  };
  assert.deepEqual(await get(a.user.id, a.workspace.slug, "prices"), {
    status: 200,
    body: { prices: [price("test.a", "1", "call"), price("test.b", "0.25", "profile")] },
  });
});

test("during a notice, next is the coming price with its date and announcement, the current price unchanged; set back, the pending version is withdrawn and next is null", async () => {
  const [a] = await createTwoWorkspaces();
  const first = ago(120_000);
  await writePrices(first, "test.a 1 call", "test.b 2 profile");
  const announced = ago(60_000);
  await writePrices(announced, "test.a 1.5 call", "test.b 2 profile");
  const current = { credits: "1", unit: "call", version: 1, effectiveFrom: first.toISOString() };
  const kept = { credits: "2", unit: "profile", version: 1, effectiveFrom: first.toISOString() };
  const next = {
    credits: "1.5",
    unit: "call",
    version: 2,
    effectiveFrom: dateOf(announced).toISOString(),
    announcedAt: announced.toISOString(),
  };
  assert.deepEqual(await get(a.user.id, a.workspace.id, "prices"), {
    status: 200,
    body: {
      prices: [
        { action: "test.a", ...current, next },
        { action: "test.b", ...kept, next: null },
      ],
    },
  });

  await writePrices(ago(1_000), "test.a 1 call", "test.b 2 profile");
  const withdrawn = await asRole("app").priceListEntry.findMany({ where: { version: 2 } });
  assert.ok(withdrawn.length === 2 && withdrawn.every((row) => row.withdrawnAt !== null));
  assert.deepEqual(await get(a.user.id, a.workspace.id, "prices"), {
    status: 200,
    body: {
      prices: [
        { action: "test.a", ...current, next: null },
        { action: "test.b", ...kept, next: null },
      ],
    },
  });
});

test("GET …/credits/usage: each row answers the price list's version its reserve charged, null for a row with none", async () => {
  const [a] = await createTwoWorkspaces();
  await grantAllowance([a.organization.id], 100);
  const { workspace } = a;
  const run = { workspaceId: workspace.id, principal: servicePrincipal("credits_test") };
  const reserve = (idempotencyKey: string) => {
    const input = { workspaceId: workspace.id, action: "test.read", quantity: 1, idempotencyKey };
    const call = () =>
      createCreditsClient().reserve({ ...input, subjectRef: "lead_test", lease: "sync" });
    return withTenant(run, call, { client: asRole("app") });
  };
  const none = await asRole("app").creditUsage.create({
    data: {
      id: newId("usage"),
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      action: "test.read",
      quantity: 1,
      credits: 4,
      idempotencyKey: "none",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      subjectRef: "lead_test",
      createdAt: ago(180_000),
    },
  });
  await writePrices(ago(120_000), "test.read 3 lead");
  const charged = await reserve("charged");
  await writePrices(ago(60_000), "test.read 2 lead");
  const dropped = await reserve("dropped");
  const { status, body } = await get(a.user.id, workspace.id, "usage");
  const items = body.items as { id: string; credits: string; priceListVersion: number | null }[];
  assert.deepEqual(
    [status, items.map(({ id, credits, priceListVersion }) => [id, credits, priceListVersion])],
    [
      200,
      [
        [dropped.usageId, "2", 2],
        [charged.usageId, "3", 1],
        [none.id, "4", null],
      ],
    ],
  );
});

test("credits.read is required: a principal without a membership in the workspace gets 403", async () => {
  const [a] = await createTwoWorkspaces();
  const nobody = await createUser();
  const forbidden = { status: 403, body: { code: "forbidden" } };
  assert.deepEqual(await get(nobody.id, a.workspace.id, "prices"), forbidden);
});

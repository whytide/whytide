// linkedin's usage route end to end (alpha-p7-040, acceptance criterion 5, the api's part;
// core/modules/linkedin/README.md "API"): the host started with identity and linkedin on the fake
// authentication adapter, in a schema of the worktree's database, on a clock the test sets. Reads
// reserved and made through the module's functions show on GET …/accounts/{id}/usage, in the
// account's quota day and window; another workspace's account is 404. It lives here: a module never
// imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// linkedin by its build's path, as src/modules.generated.ts loads it: the api does not list a module
// with a screen (core/apps/web/docs/screens.md).
const build = new URL("../../../../modules/linkedin/dist/", import.meta.url);
type Linkedin = typeof import("../../../modules/linkedin/dist/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
// The cap's bound, read as linkedin loads: its default, 250, whatever .env.local says.
delete process.env.LINKEDIN_DAILY_READ_CAP_MAX;
const linkedin: Linkedin = await import(new URL("index.js", build).href);
const testing: LinkedinTesting = await import(new URL("testing/index.js", build).href);
const { commitReads, reserveReads } = linkedin;
const { createConnectedAccount, useClock, useLinkedinClient } = testing;

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
useLinkedinClient(app);
const principal = servicePrincipal("linkedin_test");
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "linkedin", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

/** GET …/linkedin/accounts/<id>/usage in the tenant's workspace, as its Owner. */
async function usage(tenant: TestTenant, accountId: string) {
  const cookie = signInAs(tenant.user.id).map(({ name, value }) => `${name}=${value}`);
  const path = `/v1/workspaces/${tenant.workspace.id}/linkedin/accounts/${accountId}/usage`;
  const res = await fetch(new URL(path, api.url), { headers: { cookie: cookie.join("; ") } });
  return { status: res.status, body: await res.json() };
}

test("GET …/accounts/{id}/usage: the reads reserved and made today over the cap, in the account's quota day and window; another workspace's account is 404", async () => {
  const [a, b] = await createTwoWorkspaces();
  const workingHours = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
  const settings = { ownerUserId: a.user.id, timeZone: "Pacific/Auckland", workingHours };
  const { id } = await createConnectedAccount(a.workspace.id, settings);
  useClock(() => new Date("2026-10-22T22:00:00Z")); // Friday 11:00 in Auckland
  const inRun = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId: a.workspace.id, principal }, fn, { client: app });
  const reserve = (count: number) =>
    inRun(() => reserveReads({ accountId: id, count, kind: "read_profile" }));
  await reserve(30);
  const made = await reserve(20);
  assert.ok("reservationId" in made);
  await inRun(() => commitReads(made.reservationId, 15));

  assert.deepEqual(await usage(a, id), {
    status: 200,
    body: {
      quotaDay: "2026-10-23",
      cap: 100,
      capMax: 250,
      reserved: 30,
      committed: 15,
      windowOpen: true,
      nextWindowAt: "2026-10-25T19:30:00.000Z", // Monday 08:30 in Auckland
    },
  });
  assert.deepEqual(await usage(b, id), {
    status: 404,
    body: { code: "sender_account_not_found" },
  });
});

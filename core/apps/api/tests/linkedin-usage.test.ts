// linkedin's usage route end to end (alpha-p7-040, acceptance criterion 5, the api's part;
// beta-p1-020, criteria 3 and 11; core/modules/linkedin/README.md "API"): the host started with
// identity and linkedin on the fake authentication adapter, in a schema of the worktree's database,
// on a clock and a random source the test sets. Reads reserved and made through the module's
// functions show on GET …/accounts/{id}/usage, in the account's quota day and window, every old field
// unchanged, with the day's budgets beside them, drawn once with the day's row; another workspace's
// account is 404. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, newId, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// linkedin by its build's path, as src/modules.generated.ts loads it: the api does not list a module
// with a screen (core/apps/web/docs/screens.md).
const build = new URL("../../../../modules/linkedin/dist/", import.meta.url);
type Linkedin = typeof import("../../../modules/linkedin/dist/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
// The cap's bound, read as linkedin loads: its default, 100, whatever .env.local says. Empty, not
// deleted: an empty value counts as unset, and db's loadEnvLocal fills only a variable not set.
process.env.LINKEDIN_DAILY_READ_CAP_MAX = "";
const linkedin: Linkedin = await import(new URL("index.js", build).href);
const testing: LinkedinTesting = await import(new URL("testing/index.js", build).href);
const { commitReads, ids, remainingToday, reserveReads } = linkedin;
const { createConnectedAccount, openSending, useClock, useLinkedinClient, useRandom } = testing;

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

test("GET …/accounts/{id}/usage: the reads reserved and made today over the cap, in the account's quota day and window, every old field unchanged; the day's budgets, drawn once with its row, as remainingToday reads them: connection requests and messages against their limits, withdrawals, the week's connection requests and the 200; another workspace's account is 404", async () => {
  const [a, b] = await createTwoWorkspaces();
  const workingHours = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
  const settings = { ownerUserId: a.user.id, timeZone: "Pacific/Auckland", workingHours };
  const { id } = await createConnectedAccount(a.workspace.id, settings);
  useClock(() => new Date("2026-10-22T22:00:00Z")); // Friday 11:00 in Auckland
  const sources = [0, 0.999, 0.5];
  let drawn = 0;
  useRandom(() => sources[drawn++ % sources.length] ?? 0);
  const inRun = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId: a.workspace.id, principal }, fn, { client: app });
  const reserve = (count: number) =>
    inRun(() => reserveReads({ accountId: id, count, kind: "read_profile" }));
  await reserve(30);
  const made = await reserve(20);
  assert.ok("reservationId" in made);
  await inRun(() => commitReads(made.reservationId, 15));
  // The sends a campaign counted today, and the connection requests of an earlier day of the week.
  const counted = { invitesReserved: 1, invitesCommitted: 2, messagesCommitted: 3 };
  await app.senderQuotaUsage.updateMany({ where: { senderAccountId: id }, data: counted });
  await app.senderQuotaUsage.create({
    data: {
      id: newId(ids.sender_quota_usage),
      workspaceId: a.workspace.id,
      senderAccountId: id,
      quotaDay: "2026-10-20",
      timeZone: "Pacific/Auckland",
      invitesCommitted: 7,
    },
  });

  assert.deepEqual(await usage(a, id), {
    status: 200,
    body: {
      quotaDay: "2026-10-23",
      cap: 100,
      capMax: 100,
      reserved: 30,
      committed: 15,
      windowOpen: true,
      nextWindowAt: "2026-10-25T19:30:00.000Z", // Monday 08:30 in Auckland
      readAllowance: 100,
      invites: { used: 3, limit: 4 }, // 5 drawn at 0: 4
      messages: { used: 3, limit: 10 }, // 10 drawn at 0.999: 8 + 2
      withdrawals: { used: 0, max: 15 },
      weekInvites: { used: 10, cap: 100 },
      actions: { used: 51, max: 200 },
    },
  });
  await openSending(); // remainingToday answers nothing while sending is closed (beta-p1-040)
  const left = await inRun(() => remainingToday(id));
  assert.deepEqual(left, {
    invites: 1,
    messages: 7,
    withdrawals: 15,
    actions: 149, // 51 used of the 200
    windowEnd: new Date("2026-10-23T05:00:00Z"), // Friday 18:00 in Auckland
  });
  assert.equal(drawn, 3, "one draw, by the reservation that made the day's row");
  assert.deepEqual(await usage(b, id), {
    status: 404,
    body: { code: "sender_account_not_found" },
  });
});

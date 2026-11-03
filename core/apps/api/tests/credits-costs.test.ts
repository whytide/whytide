// credits' cost counter end to end (alpha-p10-010; core/modules/credits/README.md "The cost
// counter"): the host started with identity, contacts and credits without its onStart, on the fake
// authentication adapter, in a schema of the worktree's database: the week's numbers of the
// workspace, another organization's workspace its own; the current week when none is named; a week
// the calendar lacks, 400; a lead's cost, and another workspace's person 404, never a zero;
// credits.read required. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, newId, platformIds, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// credits, and qualification's snapshot factory, by their builds' paths, as src/modules.generated.ts
// loads a module: the api lists no module with a screen (core/apps/web/docs/screens.md).
const modules = new URL("../../../../modules/", import.meta.url);
type Credits = typeof import("../../../modules/credits/dist/index.js");
type QualificationTesting = typeof import("../../../modules/qualification/dist/testing/index.js");
const credits: Credits = await import(new URL("credits/dist/index.js", modules).href);
const qualification: QualificationTesting = await import(
  new URL("qualification/dist/testing/index.js", modules).href
);

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  const { onStart: _seeder, ...withoutSeeder } = credits;
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "contacts", load: () => import("@whytide/contacts") },
      { name: "credits", load: async () => withoutSeeder },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

const WEEK = "2026-W43";
const WEDNESDAY = new Date("2026-10-21T10:00:00.000Z");

/** GET /v1/workspaces/<workspace>/credits/<path>, signed in as the user. */
async function get(userId: string, workspace: string, path: string) {
  const cookie = signInAs(userId).map(({ name, value }) => `${name}=${value}`);
  const url = new URL(`/v1/workspaces/${workspace}/credits/${path}`, api.url);
  const res = await fetch(url, { headers: { cookie: cookie.join("; ") } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A committed usage row of the workspace in the week, as reserve and commit leave one. */
const spent = ({ workspace }: TestTenant, action: string, amount: string, subjectRef: string) =>
  asRole("app").creditUsage.create({
    data: {
      id: newId(credits.ids.credit_usage),
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      action,
      quantity: 1,
      credits: amount,
      status: "committed",
      idempotencyKey: newId(credits.ids.credit_usage),
      leaseExpiresAt: new Date(WEDNESDAY.getTime() + 15 * 60_000),
      subjectRef,
      createdAt: WEDNESDAY,
    },
  });

/** A cost event of the workspace in the week, as callAgent records one. */
const called = ({ workspace }: TestTenant, feature: string, unitCost: string, subjectRef: string) =>
  asRole("app").costEvent.create({
    data: {
      id: newId(platformIds.cost_event),
      workspaceId: workspace.id,
      feature,
      vendor: "example-llm",
      units: { input_tokens: 1000 },
      unitCost,
      priceListVersion: "test",
      subjectRef,
      createdAt: WEDNESDAY,
    },
  });

/** A person of the workspace with an imported lead, by contacts' commands. */
const leadOf = ({ workspace }: TestTenant, slug: string) =>
  withTenant(
    { workspaceId: workspace.id, principal: servicePrincipal("credits_test") },
    async () => {
      const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, title: "Head of Data" };
      const { person } = await upsertPersonFromSource({
        source: "import",
        provider: "csv",
        profile,
      });
      await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "csv" } });
      return person.id;
    },
    { client: asRole("app") },
  );

test("GET …/credits/costs?week=: the workspace's week by action and vendor, per 100 qualified; another organization's workspace sees its own", async () => {
  const [a, b] = await createTwoWorkspaces();
  for (const n of [1, 2, 3]) await spent(a, "qualification.assessment", "0.2", `per_${n}`);
  await spent(a, "signals.engager_read", "4", "run_1");
  await called(a, "messaging", "0.008", "per_1");
  for (const personId of ["per_1", "per_2"]) {
    const row = { workspaceId: a.workspace.id, personId, createdAt: WEDNESDAY };
    await qualification.createScoreSnapshot({ ...row, status: "qualified" });
  }
  await spent(b, "test.read", "1", "lead_b");

  const ofA = await get(a.user.id, a.workspace.id, `costs?week=${WEEK}`);
  assert.deepEqual(ofA, {
    status: 200,
    body: {
      week: WEEK,
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-10-26T00:00:00.000Z",
      credits: "4.6",
      money: "0.008",
      qualified: 2,
      byAction: [
        { action: "qualification.assessment", credits: "0.6" },
        { action: "signals.engager_read", credits: "4" },
      ],
      byVendor: [{ vendor: "example-llm", money: "0.008" }],
      costPer100Qualified: { credits: "230", money: "0.4" },
    },
  });
  const ofB = await get(b.user.id, b.workspace.id, `costs?week=${WEEK}`);
  assert.deepEqual(
    [ofB.status, ofB.body.credits, ofB.body.money, ofB.body.qualified, ofB.body.byVendor],
    [200, "1", "0", 0, []],
  );
  const now = await get(a.user.id, a.workspace.id, "costs");
  const [start, end] = [Date.parse(`${now.body.start}`), Date.parse(`${now.body.end}`)];
  assert.ok(now.status === 200 && start <= Date.now() && Date.now() < end, JSON.stringify(now));
  const lacking = await get(a.user.id, a.workspace.id, "costs?week=2025-W53");
  assert.deepEqual([lacking.status, lacking.body.code], [400, "credits_input_invalid"]);
  const shapeless = await get(a.user.id, a.workspace.id, "costs?week=last");
  assert.equal(shapeless.status, 400);
});

test("GET …/credits/leads/{personId}/cost: the lead's credits and calls; another workspace's person is 404, never a zero", async () => {
  const [a, b] = await createTwoWorkspaces();
  const personId = await leadOf(a, "costed-lead");
  await spent(a, "qualification.assessment", "0.2", personId);
  await called(a, "qualification", "0.0021", personId);
  await called(a, "messaging", "0.008", personId);

  assert.deepEqual(await get(a.user.id, a.workspace.id, `leads/${personId}/cost`), {
    status: 200,
    body: {
      personId,
      credits: "0.2",
      money: "0.0101",
      byFeature: [
        { feature: "messaging", credits: "0", money: "0.008" },
        { feature: "qualification", credits: "0.2", money: "0.0021" },
      ],
    },
  });
  const notFound = { status: 404, body: { code: "lead_not_found" } };
  const ofB = await get(b.user.id, b.workspace.id, `leads/${personId}/cost`);
  assert.deepEqual({ status: ofB.status, body: { code: ofB.body.code } }, notFound);
  const unknown = await get(a.user.id, a.workspace.id, "leads/per_unknown/cost");
  assert.deepEqual({ status: unknown.status, body: { code: unknown.body.code } }, notFound);
});

test("credits.read is required: a principal without a membership in the workspace gets 403", async () => {
  const [a] = await createTwoWorkspaces();
  const nobody = await createUser();
  const forbidden = { status: 403, body: { code: "forbidden" } };
  assert.deepEqual(await get(nobody.id, a.workspace.id, "costs"), forbidden);
  assert.deepEqual(await get(nobody.id, a.workspace.id, "leads/per_unknown/cost"), forbidden);
});

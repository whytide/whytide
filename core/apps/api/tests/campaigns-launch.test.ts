// campaigns' launch routes end to end (gamma-p3-050; core/modules/campaigns/README.md "Routes",
// "Launch checks"): the host started with identity, campaigns and credits without its onStart (its
// seeder writes the public schema), credits' client bound and its price list written here, on the
// fake authentication adapter, in a schema of the worktree's database, answering real HTTP. The
// checks read the campaign owner's LinkedIn account (linkedin's fake account rows) and the
// organization's grant: each passing, then each failing alone with its code, GET …/launch-checks
// answering what POST …/launch refuses with (409 campaign_launch_blocked), the campaign left a
// draft; with every check passing the draft becomes active with launched_at, and a second launch is
// 409 campaign_not_draft. Another workspace's campaign is 404 on both, and a Member reads the checks
// but is 403 on the launch. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { bindCreditsClient, collectLogs, createLogger } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// The modules by their builds' paths, as src/modules.generated.ts loads them.
const built = (path: string) =>
  new URL(`../../../../modules/${path}/index.js`, import.meta.url).href;
type Campaigns = typeof import("../../../modules/campaigns/dist/index.js");
type CampaignsTesting = typeof import("../../../modules/campaigns/dist/testing/index.js");
type Credits = typeof import("../../../modules/credits/dist/index.js");
type CreditsTesting = typeof import("../../../modules/credits/dist/testing/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const campaigns: Campaigns = await import(built("campaigns/dist"));
const { createDraftCampaign }: CampaignsTesting = await import(built("campaigns/dist/testing"));
const credits: Credits = await import(built("credits/dist"));
const creditsTesting: CreditsTesting = await import(built("credits/dist/testing"));
const linkedin: LinkedinTesting = await import(built("linkedin/dist/testing"));

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
creditsTesting.useCreditsClient(app);
linkedin.useLinkedinClient(app);
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
      { name: "campaigns", load: async () => campaigns },
      { name: "credits", load: async () => withoutSeeder },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
  bindCreditsClient(creditsTesting.createCreditsClient());
});
after(() => api?.close());

/** A call from the app as the user to …/workspaces/<workspace>/campaigns/<campaign>/<path>. */
async function call(user: string, ws: string, method: string, path: string) {
  const cookie = signInAs(user)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers = { cookie, "sec-fetch-site": "same-origin" };
  const url = new URL(`/v1/workspaces/${ws}/campaigns/${path}`, api.url);
  const res = await fetch(url, { method, headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A send's price, as campaigns declares it at its default setting. */
const SEND = { action: "campaigns.linkedin_send", credits: "1", unit: "send" };
/**
 * A workspace whose Owner has a draft campaign, an account connected unless `account` is false,
 * its disclosure accepted unless `disclosed` is false, and `allowance` credits.
 */
async function draft(settings: { account?: boolean; disclosed?: boolean; allowance?: number }) {
  const { account = true, disclosed = true, allowance = 1 } = settings;
  await creditsTesting.syncPrices(asRole("billing_writer"), [SEND], log, new Date(0));
  const [tenant, other] = await createTwoWorkspaces();
  const ownerUserId = tenant.user.id;
  if (allowance > 0) await creditsTesting.grantAllowance([tenant.organization.id], allowance);
  const options = { ownerUserId, personalAccount: disclosed };
  const accountId = account
    ? (await linkedin.createConnectedAccount(tenant.workspace.id, options)).id
    : "";
  const input = { workspaceId: tenant.workspace.id, ownerUserId, name: "Warm leads" };
  const { id } = await createDraftCampaign(input);
  return { tenant, other, accountId, id };
}

const checksOf = (t: TestTenant, id: string) =>
  call(t.user.id, t.workspace.id, "GET", `${id}/launch-checks`);
const launch = (t: TestTenant, id: string) =>
  call(t.user.id, t.workspace.id, "POST", `${id}/launch`);
const statusOf = async (id: string) =>
  (await app.campaign.findUniqueOrThrow({ where: { id } })).status;
const PASSING = [
  { check: "linkedin_sender", ok: true, code: null },
  { check: "sending_disclosure", ok: true, code: null },
  { check: "credits", ok: true, code: null },
];
/** The checks with the ones named failing on their codes. */
const failing = (codes: Record<string, string>) =>
  PASSING.map((row) => (row.check in codes ? { ...row, ok: false, code: codes[row.check] } : row));

test("with every check passing, GET …/launch-checks answers them and POST …/launch makes the draft active with launched_at; a second launch is 409 campaign_not_draft", async () => {
  const { tenant, id } = await draft({});
  assert.deepEqual(await checksOf(tenant, id), { status: 200, body: { checks: PASSING } });
  const launched = await launch(tenant, id);
  const launchedAt = String(launched.body.launchedAt);
  assert.ok(!Number.isNaN(Date.parse(launchedAt)), "launched now");
  assert.deepEqual(launched, { status: 200, body: { id, status: "active", launchedAt } });
  const read = await call(tenant.user.id, tenant.workspace.id, "GET", id);
  assert.deepEqual([read.body.status, read.body.launchedAt], ["active", launchedAt]);
  assert.deepEqual(await launch(tenant, id), {
    status: 409,
    body: { code: "campaign_not_draft" },
  });
});

test("each check fails alone with its code: GET …/launch-checks answers it and POST …/launch is 409 campaign_launch_blocked with the checks, the campaign left a draft", async () => {
  const cases = [
    {
      made: await draft({ account: false }),
      checks: failing({
        linkedin_sender: "no_linkedin_sender",
        sending_disclosure: "disclosure_required",
      }),
    },
    {
      made: await draft({}),
      flip: (accountId: string) => linkedin.setHealth(accountId, "restricted"),
      checks: failing({ linkedin_sender: "linkedin_sender_unhealthy" }),
    },
    {
      made: await draft({}),
      flip: (accountId: string) => linkedin.setAccountPaused(accountId, "operator"),
      checks: failing({ linkedin_sender: "linkedin_sender_unhealthy" }),
    },
    {
      made: await draft({ disclosed: false }),
      checks: failing({ sending_disclosure: "disclosure_required" }),
    },
    {
      made: await draft({ allowance: 0 }),
      checks: failing({ credits: "insufficient_credits" }),
    },
  ];
  for (const { made, flip, checks } of cases) {
    await flip?.(made.accountId);
    assert.deepEqual(await checksOf(made.tenant, made.id), { status: 200, body: { checks } });
    assert.deepEqual(await launch(made.tenant, made.id), {
      status: 409,
      body: { code: "campaign_launch_blocked", details: { checks } },
    });
    assert.equal(await statusOf(made.id), "draft");
  }
});

test("another workspace's campaign is 404 campaign_not_found on both routes, as an unknown id; a Member reads the checks but is 403 forbidden on the launch", async () => {
  const { tenant, other, id } = await draft({});
  const missing = { status: 404, body: { code: "campaign_not_found" } };
  for (const campaignId of [id, "cmp_unknown"]) {
    if (campaignId !== id) assert.deepEqual(await checksOf(tenant, campaignId), missing);
    assert.deepEqual(await checksOf(other, campaignId), missing);
    assert.deepEqual(await launch(other, campaignId), missing);
  }
  const member = await createUser();
  const ws = tenant.workspace.id;
  await createMembership({ userId: member.id, workspaceId: ws, role: "Member" });
  const read = await call(member.id, ws, "GET", `${id}/launch-checks`);
  assert.deepEqual(read, { status: 200, body: { checks: PASSING } });
  assert.deepEqual(await call(member.id, ws, "POST", `${id}/launch`), {
    status: 403,
    body: { code: "forbidden" },
  });
  assert.equal(await statusOf(id), "draft");
});

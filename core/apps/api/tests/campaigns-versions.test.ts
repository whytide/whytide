// campaigns' campaign routes end to end (gamma-p3-030; core/modules/campaigns/README.md "Routes"):
// the host started with identity and campaigns, on the fake authentication adapter, in a schema of
// the worktree's database, answering real HTTP. The first read makes the seeded campaign, owned by
// the workspace's Owner, with beta's template as its version 1, and a second read makes none; a
// version 2, written to the tables as campaigns leaves one, is the one answered; ?playbookId= answers
// the agent's campaign alone (gamma-p3-065); another workspace's campaign is 404
// campaign_not_found; campaigns.read is required. The campaign's GET answers its approval mode, the
// seeded one's lock its launch plus 7 days (gamma-p4-070). It lives here: a module never imports a
// host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, newId } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, createUser, useTenancyClient } from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// The module by its build's path, as src/modules.generated.ts loads it (campaigns-enrollments.test.ts).
const built = (path: string) =>
  new URL(`../../../../modules/${path}/index.js`, import.meta.url).href;
type Campaigns = typeof import("../../../modules/campaigns/dist/index.js");
const campaigns: Campaigns = await import(built("campaigns/dist"));

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "campaigns", load: async () => campaigns },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

/** A delay of business days after the step before. */
const later = (value: number) => ({ anchor: "prev_step", unit: "business_days", value });
/** Beta's template as the seeded campaign's version 1 answers it. */
const TEMPLATE = [
  { position: 1, stepKey: "connect", action: "invite", delay: { anchor: "enrollment" } },
  {
    ...{ position: 2, stepKey: "message_1", action: "message" },
    delay: { anchor: "accepted", unit: "hours", min: 1, max: 3, minMinutes: 10 },
  },
  { position: 3, stepKey: "follow_up_1", action: "message", delay: later(3) },
  { position: 4, stepKey: "follow_up_2", action: "message", delay: later(5) },
].map((step) => ({ ...step, channel: "linkedin" }));

type Listed = { id: string; ownerUserId: string; launchedAt: string };
const DAY_MS = 24 * 60 * 60 * 1000;
/** A campaign's approval mode in its first 7 days, whatever it says (gamma-p4-070). */
const EVERYTHING = "review_everything";

/** GET …/campaigns<path> of the workspace, signed in as the user. */
async function read(userId: string, workspaceId: string, path = "") {
  const cookie = signInAs(userId).map(({ name, value }) => `${name}=${value}`);
  const url = new URL(`/v1/workspaces/${workspaceId}/campaigns${path}`, api.url);
  const res = await fetch(url, { headers: { cookie: cookie.join("; ") } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The workspace's campaigns as the list answers them. */
async function listed(userId: string, workspaceId: string): Promise<Listed[]> {
  const { status, body } = await read(userId, workspaceId);
  assert.equal(status, 200);
  return body.campaigns as Listed[];
}

test("GET …/campaigns makes the seeded campaign at the first read, owned by the workspace's Owner, with beta's template as version 1; a second read makes none", async () => {
  const [a] = await createTwoWorkspaces();
  const first = await read(a.user.id, a.workspace.id);
  const [seeded, ...others] = (first.body.campaigns ?? []) as Listed[];
  assert.ok(seeded);
  assert.deepEqual(others, []);
  assert.match(seeded.id, /^cmp_/);
  assert.ok(!Number.isNaN(Date.parse(seeded.launchedAt)), "launched");
  assert.deepEqual(first, {
    status: 200,
    body: {
      campaigns: [
        {
          ...{ id: seeded.id, name: "", status: "active", ownerUserId: a.user.id },
          ...{ playbookId: null, versionNo: 1, stepCount: 4, launchedAt: seeded.launchedAt },
        },
      ],
    },
  });
  assert.deepEqual(await read(a.user.id, a.workspace.id), first, "a second read makes none");
  const lockedUntil = new Date(Date.parse(seeded.launchedAt) + 7 * DAY_MS).toISOString();
  assert.deepEqual(await read(a.user.id, a.workspace.id, `/${seeded.id}`), {
    status: 200,
    body: {
      ...(first.body.campaigns as object[])[0],
      steps: TEMPLATE,
      approvalMode: { mode: EVERYTHING, effectiveMode: EVERYTHING, lockedUntil },
    },
  });
});

test("GET …/campaigns/{campaignId} answers the current version: a version 2 written as campaigns leaves one", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const [seeded] = await listed(a.user.id, workspaceId);
  assert.ok(seeded);
  const campaignVersionId = newId(campaigns.ids.campaign_version);
  await app.campaignVersion.create({
    data: {
      ...{ id: campaignVersionId, workspaceId, campaignId: seeded.id, versionNo: 2 },
      ...{ changeKind: "structural", createdBy: a.user.id },
    },
  });
  const steps = [
    { position: 1, stepKey: "connect", actionType: "invite", channel: "linkedin" },
    { position: 2, stepKey: "email_1", actionType: "email", channel: "email" },
  ] as const;
  const delays = [{ anchor: "enrollment" }, later(2)];
  await app.step.createMany({
    data: steps.map((step, index) => ({
      ...{ ...step, id: newId(campaigns.ids.step), workspaceId, campaignVersionId },
      ...{ delay: delays[index] ?? {}, stepTemplateHash: step.stepKey },
    })),
  });
  await app.campaign.update({
    where: { id: seeded.id },
    data: { currentVersionId: campaignVersionId },
  });
  const current = { ...seeded, name: "", status: "active", versionNo: 2, stepCount: 2 };
  assert.deepEqual(await listed(a.user.id, workspaceId), [current]);
  const { reviewLockedUntil } = await app.campaign.findUniqueOrThrow({ where: { id: seeded.id } });
  const lockedUntil = reviewLockedUntil.toISOString();
  assert.deepEqual(await read(a.user.id, workspaceId, `/${seeded.id}`), {
    status: 200,
    body: {
      ...current,
      approvalMode: { mode: EVERYTHING, effectiveMode: EVERYTHING, lockedUntil },
      steps: [
        {
          position: 1,
          stepKey: "connect",
          action: "invite",
          channel: "linkedin",
          delay: delays[0],
        },
        { position: 2, stepKey: "email_1", action: "email", channel: "email", delay: later(2) },
      ],
    },
  });
});

test("GET …/campaigns?playbookId= answers the agent's campaign alone, none for an agent without one or another workspace's; 400 for an empty id", async () => {
  const [a, b] = await createTwoWorkspaces();
  const [seeded] = await listed(a.user.id, a.workspace.id);
  assert.ok(seeded);
  // Two agents' campaigns, as campaigns' subscriber to playbooks.playbook_created leaves them.
  const agentsCampaign = async (workspaceId: string, playbookId: string) => {
    const id = newId(campaigns.ids.campaign);
    const row = { id, workspaceId, keyRef: id, name: playbookId, status: "draft" } as const;
    const owner = { ownerUserId: a.user.id, createdBy: "system", playbookId };
    await app.campaign.create({ data: { ...row, ...owner } });
    return id;
  };
  const mine = await agentsCampaign(a.workspace.id, "pbk_mine");
  await agentsCampaign(a.workspace.id, "pbk_other");
  await agentsCampaign(b.workspace.id, "pbk_theirs");
  const filtered = await read(a.user.id, a.workspace.id, "?playbookId=pbk_mine");
  assert.deepEqual(filtered, {
    status: 200,
    body: {
      campaigns: [
        {
          ...{ id: mine, name: "pbk_mine", status: "draft", ownerUserId: a.user.id },
          ...{ playbookId: "pbk_mine", versionNo: null, stepCount: 0, launchedAt: null },
        },
      ],
    },
  });
  assert.equal((await listed(a.user.id, a.workspace.id)).length, 3, "unfiltered, all three");
  const none = { status: 200, body: { campaigns: [] } };
  assert.deepEqual(await read(a.user.id, a.workspace.id, "?playbookId=pbk_none"), none);
  assert.deepEqual(await read(a.user.id, a.workspace.id, "?playbookId=pbk_theirs"), none);
  assert.deepEqual(await read(a.user.id, a.workspace.id, "?playbookId="), {
    status: 400,
    body: { code: "validation_failed", details: { fields: ["playbookId"] } },
  });
});

test("GET …/campaigns never answers another workspace's campaign: 404 campaign_not_found, as for an unknown id; 400 for an id over 64 characters", async () => {
  const [a, b] = await createTwoWorkspaces();
  const [ofA] = await listed(a.user.id, a.workspace.id);
  const [ofB, ...more] = await listed(b.user.id, b.workspace.id);
  assert.ok(ofA && ofB);
  assert.deepEqual(more, []);
  assert.notEqual(ofA.id, ofB.id);
  assert.equal(ofB.ownerUserId, b.user.id);
  const missing = { status: 404, body: { code: "campaign_not_found" } };
  assert.deepEqual(await read(a.user.id, a.workspace.id, `/${ofB.id}`), missing);
  assert.deepEqual(await read(a.user.id, a.workspace.id, "/cmp_unknown"), missing);
  assert.deepEqual(await read(a.user.id, a.workspace.id, `/${"x".repeat(65)}`), {
    status: 400,
    body: { code: "validation_failed", details: { fields: ["campaignId"] } },
  });
});

test("campaigns.read is required: a signed-in user who is no member of the workspace gets 403, and nothing is seeded", async () => {
  const [a] = await createTwoWorkspaces();
  const nobody = await createUser();
  const forbidden = { status: 403, body: { code: "forbidden" } };
  assert.deepEqual(await read(nobody.id, a.workspace.id), forbidden);
  assert.deepEqual(await read(nobody.id, a.workspace.id, "/cmp_unknown"), forbidden);
  assert.equal(await app.campaign.count(), 0);
});

// Members own their agents end to end (gamma-p6-015; core/packages/platform/README.md "Principal and
// permissions", each module's README "Decided here"): the host started with identity, icp, signals,
// playbooks, campaigns and credits without its onStart (its seeder writes the public schema),
// credits' client bound and its price list written here, on the fake authentication adapter, in a
// schema of the worktree's database, answering real HTTP. A workspace whose Owner is Olga and whose
// Members are Mia and Max. Every write route of the four modules is made first by the one who may
// not make it, 403 forbidden with every row of the workspace and its outbox as they were, then by
// one who may, which the route answers as it does: the refusal is the owner check's alone. Mia's
// audience, source and agent, made through their routes, record her; she writes them, and her
// campaign, launched, paused and resumed, and its enrollment; Max is refused each, and Olga writes
// each. The workspace's rows are refused to Mia and written by Olga: the default audience, even the
// one Mia's own read made, an audience whose created_by is null or system, a source a service made,
// the seeded campaign, its Owner's, and its enrollment. A source reads through its creator's own
// sender account: Mia's create, import check and import on Olga's are refused, and Olga makes each.
// The enrollments are written as campaigns leaves them (@whytide/campaigns/testing). It lives here:
// a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { bindCreditsClient, collectLogs, createLogger, newId } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// The modules and their test hooks by their builds' paths, as src/modules.generated.ts loads them.
const built = (path: string) =>
  new URL(`../../../../modules/${path}/index.js`, import.meta.url).href;
type CampaignsTesting = typeof import("../../../modules/campaigns/dist/testing/index.js");
type Credits = typeof import("../../../modules/credits/dist/index.js");
type CreditsTesting = typeof import("../../../modules/credits/dist/testing/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
const campaigns: CampaignsTesting = await import(built("campaigns/dist/testing"));
const credits: Credits = await import(built("credits/dist"));
const creditsTesting: CreditsTesting = await import(built("credits/dist/testing"));
const linkedin: LinkedinTesting = await import(built("linkedin/dist/testing"));
const signals: SignalsTesting = await import(built("signals/dist/testing"));

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
creditsTesting.useCreditsClient(app);
linkedin.useLinkedinClient(app);
signals.useSignalsClient(app);
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
      { name: "icp", load: () => import(built("icp/dist")) },
      { name: "signals", load: () => import(built("signals/dist")) },
      { name: "playbooks", load: () => import(built("playbooks/dist")) },
      { name: "campaigns", load: () => import(built("campaigns/dist")) },
      { name: "credits", load: async () => withoutSeeder },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
  bindCreditsClient(creditsTesting.createCreditsClient());
});
after(() => api?.close());

type Who = { readonly userId: string; readonly cookie: string };
type Answer = { readonly status: number; readonly body: Record<string, unknown> };
type Write = readonly [method: string, path: string, body?: object];

const signedIn = (userId: string): Who => ({
  userId,
  cookie: signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; "),
});

/** A call to /v1/workspaces/<ws><path> as `who`, from the app: JSON when a body, a POST keyed. */
async function call(who: Who, ws: string, [method, path, body]: Write): Promise<Answer> {
  const headers: Record<string, string> = { cookie: who.cookie, "sec-fetch-site": "same-origin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method === "POST") headers["idempotency-key"] = randomUUID();
  const url = new URL(`/v1/workspaces/${ws}${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: json });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** Every row of the workspace in the four modules' tables, and its outbox. */
async function rowsOf(workspaceId: string) {
  const where = { workspaceId };
  const orderBy = { id: "asc" } as const;
  return {
    icps: await app.icp.findMany({ where, orderBy }),
    criteria: await app.criterion.findMany({ where, orderBy }),
    sources: await app.signalSource.findMany({ where, orderBy }),
    imports: await app.signalSourceImport.findMany({ where, orderBy }),
    runs: await app.signalRun.findMany({ where, orderBy }),
    agents: await app.playbook.findMany({ where, orderBy }),
    links: await app.playbookSource.findMany({ where, orderBy }),
    campaigns: await app.campaign.findMany({ where, orderBy }),
    versions: await app.campaignVersion.findMany({ where, orderBy }),
    steps: await app.step.findMany({ where, orderBy }),
    enrollments: await app.enrollment.findMany({ where, orderBy }),
    stepExecutions: await app.stepExecution.findMany({ where, orderBy }),
    outbox: await app.outboxEntry.findMany({ where, orderBy }),
  };
}

const FORBIDDEN = { status: 403, body: { code: "forbidden" } };

/**
 * The write as `refused` is 403 forbidden and leaves every row of the workspace as it was; then the
 * same write as `allowed` answers `status`, so the refusal was the owner check's, not the route's.
 */
async function refusedThenMade(
  ws: string,
  [refused, allowed]: readonly [Who, Who],
  write: Write,
  status: number,
): Promise<Answer> {
  const name = `${write[0]} ${write[1]}`;
  const before = await rowsOf(ws);
  assert.deepEqual(await call(refused, ws, write), FORBIDDEN, name);
  assert.deepEqual(await rowsOf(ws), before, `${name}: nothing changes`);
  const answer = await call(allowed, ws, write);
  assert.equal(answer.status, status, `${name}: ${JSON.stringify(answer.body)}`);
  return answer;
}

/** A send's price, as campaigns declares it at its default setting (campaigns-launch.test.ts). */
const SEND = { action: "campaigns.linkedin_send", credits: "1", unit: "send" };
const POST_URL =
  "https://www.linkedin.com/posts/example-author_launch-day-activity-7250000000000000000-AbCd";
const IMPORTED_POST = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000001";
const FIELDS = {
  name: "Bakeries",
  titles: ["Owner"],
  seniorities: ["owner_founder"],
  industries: ["Food and beverage"],
  sizeRanges: ["11-50"],
  countries: ["FR"],
  mustHaves: "",
  disqualifiers: "",
};
/** icp's default criteria with ten points moved from industry to seniority. */
const MOVED = [
  { key: "title_function", weight: 30, isMust: true, enabled: true },
  { key: "seniority", weight: 25, isMust: false, enabled: true },
  { key: "company_size", weight: 10, isMust: false, enabled: true },
  { key: "industry", weight: 5, isMust: false, enabled: true },
  { key: "location", weight: 10, isMust: true, enabled: true },
  { key: "must_haves", weight: 20, isMust: false, enabled: true },
];
const SEQUENCE = { steps: [{ action: "invite" }, { action: "message" }], emailFallback: false };
const BRIEF = { brief: "Bakeries in France" };

/**
 * A workspace whose Owner is Olga and whose Members are Mia and Max, each signed in; Mia's connected
 * account, its disclosure accepted, and the organization's credits for a launch.
 */
async function world() {
  await creditsTesting.syncPrices(asRole("billing_writer"), [SEND], log, new Date(0));
  const [tenant] = await createTwoWorkspaces();
  const ws = tenant.workspace.id;
  const member = async () => {
    const user = await createUser();
    await createMembership({ userId: user.id, workspaceId: ws, role: "Member" });
    return signedIn(user.id);
  };
  const [olga, mia, max] = [signedIn(tenant.user.id), await member(), await member()];
  await creditsTesting.grantAllowance([tenant.organization.id], 10);
  const account = { ownerUserId: mia.userId, personalAccount: true };
  const senderAccountId = (await linkedin.createConnectedAccount(ws, account)).id;
  return { ws, olga, mia, max, senderAccountId };
}
type World = Awaited<ReturnType<typeof world>>;

/**
 * Mia's audience, source and agent, made through their routes, each recording her; her draft
 * campaign, as gamma-p3-065 makes an agent's, and an active enrollment of it.
 */
async function miasRows({ ws, mia, senderAccountId }: World) {
  const audience = await call(mia, ws, ["POST", "/icp/audiences", { name: "Mia's bakeries" }]);
  const icpId = String(audience.body.id);
  const source = await call(mia, ws, [
    "POST",
    "/signals/sources",
    { kind: "post_engagers", config: { postUrl: POST_URL }, label: "Mia's post", senderAccountId },
  ]);
  const agent = await call(mia, ws, ["POST", "/playbooks", { name: "Mia's agent", icpId }]);
  assert.deepEqual(
    [audience.status, audience.body.createdBy, source.status, source.body.createdBy],
    [201, mia.userId, 201, mia.userId],
  );
  assert.deepEqual([agent.status, agent.body.ownerUserId], [201, mia.userId]);
  const input = { workspaceId: ws, ownerUserId: mia.userId, name: "Mia's campaign" };
  const campaign = await campaigns.createDraftCampaign(input);
  const enrollment = await campaigns.createEnrollment({
    ...{ workspaceId: ws, personId: "per_mias_lead", senderAccountId },
  });
  // createEnrollment joins the seeded campaign; this one joins Mia's, whose key is its id.
  await app.enrollment.update({ where: { id: enrollment.id }, data: { templateId: campaign.id } });
  return {
    icpId,
    sourceId: String(source.body.id),
    agentId: String(agent.body.id),
    campaignId: campaign.id,
    enrollmentId: enrollment.id,
  };
}

/**
 * Each write route of the four modules on Mia's rows, refused to Max, then made by `allowed`: her,
 * their owner, or the Owner. Last, the campaign reads as written, still hers, and her source goes.
 */
async function writeMiasRows(w: World, allowed: Who): Promise<void> {
  const rows = await miasRows(w);
  const write = (made: Write, status: number) =>
    refusedThenMade(w.ws, [w.max, allowed], made, status);
  const audience = `/icp/audiences/${rows.icpId}`;
  const saved = await write(["PUT", audience, FIELDS], 200);
  assert.deepEqual([saved.body.version, saved.body.titles], [2, ["Owner"]]);
  assert.deepEqual((await write(["PUT", `${audience}/criteria`, { criteria: MOVED }], 200)).body, {
    criteria: MOVED,
  });
  await write(["POST", `/icp/draft?icpId=${rows.icpId}`, BRIEF], 202);
  // Past the owner check, the draft's own rule answers: the worker has proposed nothing yet.
  const review = [
    await write(["POST", `/icp/draft/accept?icpId=${rows.icpId}`, { runId: "idrun_none" }], 409),
    await write(["POST", `/icp/draft/discard?icpId=${rows.icpId}`], 409),
  ];
  assert.deepEqual(
    review.map(({ body }) => body.code),
    ["icp_draft_none", "icp_draft_none"],
  );

  const source = `/signals/sources/${rows.sourceId}`;
  const relabeled = await write(["PATCH", source, { label: "Launch post" }], 200);
  assert.deepEqual([relabeled.body.label, relabeled.body.createdBy], ["Launch post", w.mia.userId]);
  const run = await write(["POST", `${source}/run`], 202);
  await write(["POST", `${source}/runs/${String(run.body.id)}/stop`], 202);

  const agent = `/playbooks/${rows.agentId}`;
  await write(["PATCH", agent, { name: "Bakery agent" }], 200);
  await write(["PATCH", agent, { status: "paused" }], 200);
  await write(["PATCH", agent, { status: "active" }], 200);
  const linked = await write(["PUT", `${agent}/sources`, { sourceIds: [rows.sourceId] }], 200);
  assert.deepEqual(
    [linked.body.sourceIds, linked.body.ownerUserId],
    [[rows.sourceId], w.mia.userId],
  );

  const campaign = `/campaigns/${rows.campaignId}`;
  assert.equal((await write(["PUT", `${campaign}/sequence`, SEQUENCE], 200)).body.versionNo, 2);
  await write(["PATCH", campaign, { name: "Warm bakeries" }], 200);
  await write(["POST", `${campaign}/launch`], 200);
  await write(["POST", `${campaign}/pause`], 200);
  await write(["POST", `${campaign}/resume`], 200);
  const enrollment = `/campaigns/enrollments/${rows.enrollmentId}`;
  await write(["POST", `${enrollment}/pause`, {}], 200);
  await write(["POST", `${enrollment}/resume`], 200);
  const { body } = await call(w.mia, w.ws, ["GET", campaign]);
  assert.deepEqual(
    [body.name, body.status, body.versionNo, body.ownerUserId],
    ["Warm bakeries", "active", 2, w.mia.userId],
  );

  await write(["DELETE", source], 204);
}

test("a Member writes the audience, the source and the agent she made, which record her, and the campaign she owns, launching it, and its enrollment, through every write route; another Member's same write is 403 forbidden first, and changes nothing", async () => {
  const w = await world();
  await writeMiasRows(w, w.mia);
});

test("an Owner writes a Member's audience, source, agent and campaign through every write route, each refused to another Member first", async () => {
  const w = await world();
  await writeMiasRows(w, w.olga);
});

test("the workspace's rows are the manage actions': a Member's write of the default audience, even the one her own read made, of an audience whose created_by is null or system, of a source a service made, of the seeded campaign, its Owner's, and of its enrollment is 403 forbidden and changes nothing; the Owner then makes each", async () => {
  const w = await world();
  const { ws, mia, olga } = w;
  const write = (made: Write, status: number) => refusedThenMade(ws, [mia, olga], made, status);
  // Mia's first reads make the default audience, she its creator, and the seeded campaign, Olga's.
  assert.equal((await call(mia, ws, ["GET", "/icp"])).status, 200);
  const theDefault = await app.icp.findFirstOrThrow({
    where: { workspaceId: ws, isDefault: true },
  });
  assert.equal(theDefault.createdBy, mia.userId, "her read made it");
  const listed = await call(mia, ws, ["GET", "/campaigns"]);
  const [seeded] = listed.body.campaigns as { id: string; ownerUserId: string }[];
  assert.equal(seeded?.ownerUserId, olga.userId, "the seeded campaign is the Owner's");

  await write(["PUT", "/icp", FIELDS], 200);
  await write(["PUT", "/icp/criteria", { criteria: MOVED }], 200);
  await write(["PUT", `/icp/audiences/${theDefault.id}`, { ...FIELDS, titles: ["CFO"] }], 200);
  await write(["POST", "/icp/draft", BRIEF], 202);
  for (const createdBy of [null, "system"]) {
    const made = await call(olga, ws, ["POST", "/icp/audiences", { name: `By ${createdBy}` }]);
    const icpId = String(made.body.id);
    await app.icp.update({ where: { id: icpId }, data: { createdBy } });
    await write(["PUT", `/icp/audiences/${icpId}`, FIELDS], 200);
    await write(["PUT", `/icp/audiences/${icpId}/criteria`, { criteria: MOVED }], 200);
  }

  const sourceId = newId("src");
  await app.signalSource.create({
    data: {
      ...{ id: sourceId, workspaceId: ws, kind: "post_engagers", config: { postUrl: POST_URL } },
      ...{ label: "A service's", senderAccountId: w.senderAccountId, createdBy: "service:worker" },
    },
  });
  const source = `/signals/sources/${sourceId}`;
  await write(["PATCH", source, { label: "Kept" }], 200);
  const run = await write(["POST", `${source}/run`], 202);
  await write(["POST", `${source}/runs/${String(run.body.id)}/stop`], 202);
  await write(["DELETE", source], 204);

  const campaign = `/campaigns/${seeded?.id}`;
  await write(["PUT", `${campaign}/sequence`, SEQUENCE], 200);
  await write(["PATCH", campaign, { name: "Warm leads" }], 200);
  await write(["POST", `${campaign}/pause`], 200);
  await write(["POST", `${campaign}/resume`], 200);
  // Launched at its seed: past the owner check, the launch's own rule answers.
  const launched = await write(["POST", `${campaign}/launch`], 409);
  assert.equal(launched.body.code, "campaign_not_draft");
  const { id: enrollmentId } = await campaigns.createEnrollment({
    ...{ workspaceId: ws, personId: "per_seeded_lead", senderAccountId: w.senderAccountId },
  });
  await write(["POST", `/campaigns/enrollments/${enrollmentId}/pause`, {}], 200);
  await write(["POST", `/campaigns/enrollments/${enrollmentId}/resume`], 200);
});

test("a source reads through its creator's own sender account: a Member's create, import check and import on the Owner's account are 403 forbidden and write nothing, no source, no import, no event; the Owner makes each on her own", async () => {
  const { ws, mia, olga } = await world();
  const write = (made: Write, status: number) => refusedThenMade(ws, [mia, olga], made, status);
  const { id: senderAccountId } = await linkedin.createConnectedAccount(ws, {
    ownerUserId: olga.userId,
  });
  const post = { kind: "post_engagers", config: { postUrl: POST_URL }, label: "Olga's post" };
  const made = await write(["POST", "/signals/sources", { ...post, senderAccountId }], 201);
  assert.deepEqual(
    [made.body.createdBy, made.body.senderAccountId],
    [olga.userId, senderAccountId],
  );

  const csv = `kind,url,name,phrase,roles,label\npost,${IMPORTED_POST},,,,Imported post\n`;
  const file = { fileName: "sources.csv", file: Buffer.from(csv).toString("base64") };
  const body = { ...file, senderAccountId };
  const checked = await write(["POST", "/signals/sources/imports/check", body], 200);
  assert.deepEqual(checked.body, {
    ...{ fileName: "sources.csv", rows: 1, errors: [] },
    valid: [{ row: 2, kind: "post_engagers", label: "Imported post" }],
  });
  const imported = await write(["POST", "/signals/sources/imports", body], 201);
  const { createdBy, created } = imported.body.sourceImport as Record<string, unknown>;
  assert.deepEqual([createdBy, created, imported.body.errors], [olga.userId, 1, []]);
});

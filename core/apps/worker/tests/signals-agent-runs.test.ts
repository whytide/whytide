// signals' runs by agent end to end (gamma-p5-045; core/modules/signals/README.md "Runs",
// "Processing"), on the slice's Temporal and a schema of its database: credits, linkedin and signals
// loaded from their builds by the worker's own loader, their activities through the host's wrapper on
// one worker of the test's queue, on the LinkedIn and files fakes, linkedin's clock a working
// Wednesday at 10:00 UTC. The agents are playbooks', written by its factory, on icp's audiences. A
// run of a source in an agent drops by that agent's audience, one in no agent by the default; its
// history carries the agent's id, never its audience. An account's reads after the 20 kept are
// shared by agent, then within each agent. A paused agent's sources read nothing, whatever the
// pause's reason (paused-agent-sources): their runs end at the start, the tick writes them none and
// the share leaves them out. The first run's history is
// workflows/__histories__/signals_run_agent.json (history:record).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";
// No workspace here has an offer to rate against, and the triage's agent is not loaded: the rules
// decide; the LLM port is the fake whatever the slice says.
process.env.PROVIDER_LLM = "fake";

const { NativeConnection, Worker } = await import("@temporalio/worker");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { getAdapter, linkedinPort } = await import("@whytide/providers");
const { grantAllowance, useCreditsClient } = await import("@whytide/credits/testing");
const { hostActivity } = await import("../src/activities.ts");
const { workerConfig } = await import("../src/config.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { IDENTITY, metricSinks, workflowBundle } = await import("../src/temporal.ts");
const { withTestWorkflowEnvironment } = await import("../testing/index.ts");

// The modules' commands and test hooks by their builds' paths, the files the worker's loader imports.
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
type ContactsTesting = typeof import("../../../modules/contacts/dist/testing/index.js");
type CreditsPrices = typeof import("../../../modules/credits/dist/domain/prices.js");
type IcpCommands = typeof import("../../../modules/icp/dist/domain/commands.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type PlaybooksDomain = typeof import("../../../modules/playbooks/dist/domain/playbooks.js");
type PlaybooksTesting = typeof import("../../../modules/playbooks/dist/testing/index.js");
type Sources = typeof import("../../../modules/signals/dist/domain/sources.js");
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const contacts: ContactsTesting = await built("contacts/dist/testing/index.js");
const { assemblePrices, syncPrices }: CreditsPrices = await built("credits/dist/domain/prices.js");
const icp: IcpCommands = await built("icp/dist/domain/commands.js");
const linkedin: LinkedinTesting = await built("linkedin/dist/testing/index.js");
const { updatePlaybook }: PlaybooksDomain = await built("playbooks/dist/domain/playbooks.js");
const playbooks: PlaybooksTesting = await built("playbooks/dist/testing/index.js");
const { requestRun }: Sources = await built("signals/dist/domain/sources.js");
const signals: SignalsTesting = await built("signals/dist/testing/index.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");
const signalsPrices = new URL("../../../modules/signals/dist/prices.js", import.meta.url).href;
type LinkedinFake = import("@whytide/providers").LinkedinFake;
type Engager = import("@whytide/providers").FakeEngager;
type Post = import("@whytide/providers").LinkedinPost;
type Tenant = Awaited<ReturnType<TenancyTesting["createTwoWorkspaces"]>>[number];
type TenantClient = import("@whytide/db").TenantClient;
type RunResult = { runId: string; status: string };

withTestDb();
const env = withTestWorkflowEnvironment();
const db = () => asRole("app");
useCreditsClient(db());
linkedin.useLinkedinClient(db());
tenancy.useTenancyClient(db());
signals.useSignalsClient(db());
playbooks.usePlaybooksClient(db());
contacts.useHashSalt("test-salt-".repeat(4));
linkedin.useSecretKeys(platform.loadMasterKeys({ APP_MASTER_KEY: platform.newMasterKey() }));
const log = platform.createLogger({ destination: platform.collectLogs().destination });
const names = new Set(["credits", "linkedin", "signals"]);
const loaded = await loadModules(moduleLoaders.filter(({ name }) => names.has(name)));
await startModules(loaded, log);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: db(), log })];
  }),
);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal: platform.servicePrincipal("test") }, fn, { client: db() });
const WEDNESDAY = new Date("2026-10-07T10:00:00.000Z");
const FEED = "https://www.linkedin.com/feed/update/urn:li:";
const CITIES = { DE: "Berlin, Germany", FR: "Paris, France" } as const;
const stamp = Date.now();

let connection: import("@temporalio/worker").NativeConnection | undefined;
let worker: import("@temporalio/worker").Worker | undefined;
let running: Promise<void> | undefined;
before(async () => {
  connection = await NativeConnection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  worker = await Worker.create({
    connection,
    namespace: env.namespace,
    taskQueue: env.taskQueue,
    identity: IDENTITY,
    workflowBundle: await workflowBundle(env.workflowsPath),
    activities,
    sinks: metricSinks(),
  });
  running = worker.run();
});
after(async () => {
  linkedin.useClock(undefined);
  worker?.shutdown();
  await running;
  await connection?.close();
});

/** A workflow run to its end on the test's worker, under `workflowId` when given: its result. */
function execute<T>(workflow: string, input: object, workflowId?: string): Promise<T> {
  return env.client.workflow.execute(workflow, {
    args: [input],
    taskQueue: env.taskQueue,
    workflowId: workflowId ?? `${workflow}-${randomUUID()}`,
    workflowExecutionTimeout: "1 minute",
  }) as Promise<T>;
}

/** The price list as the api's start writes it: signals' prices, in a process of their own. */
async function writePrices() {
  const script = [
    'const { registeredPrices } = await import("@whytide/platform");',
    `await import(${JSON.stringify(signalsPrices)});`,
    "process.stdout.write(JSON.stringify([...registeredPrices().values()]));",
  ].join("\n");
  const declared = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: { APP_ENV: "test" },
    encoding: "utf8",
  });
  assert.equal(declared.status, 0, declared.stderr);
  await syncPrices(asRole("billing_writer"), assemblePrices(JSON.parse(declared.stdout), {}), log);
}

/** A workspace with credits and a connected account the fake knows, reading `cap` a day. */
async function workspaceOf(cap: number) {
  await writePrices();
  const [tenant] = await tenancy.createTwoWorkspaces();
  await grantAllowance([tenant.organization.id], 100);
  const providerAccountRef = `fake-account-${randomUUID()}`;
  fake.emitWebhook("account.connected", providerAccountRef);
  const { id } = await linkedin.createConnectedAccount(tenant.workspace.id, { providerAccountRef });
  await db().senderAccount.update({ where: { id }, data: { dailyReadCap: cap } });
  return { tenant, workspaceId: tenant.workspace.id, accountId: id, providerAccountRef };
}

/** A new audience of the workspace, icp's, in these countries: its id. */
async function audienceIn(tenant: Tenant, name: string, countries: string[]): Promise<string> {
  const workspaceId = tenant.workspace.id;
  const { id } = await inRun(workspaceId, () =>
    icp.createAudience({ name, createdBy: tenant.user.id }),
  );
  await inRun(workspaceId, (tx) => tx.icp.update({ where: { id }, data: { countries } }));
  return id;
}

/** A source of `kind` on the account, enabled. */
async function sourceOn(tenant: Tenant, accountId: string, kind: string, config: object) {
  const workspaceId = tenant.workspace.id;
  const { id } = await db().signalSource.create({
    data: {
      ...{ id: platform.newId("src"), workspaceId, kind, config, label: kind },
      ...{ senderAccountId: accountId, createdBy: tenant.user.id },
    },
  });
  return { workspaceId, sourceId: id };
}
type Source = Awaited<ReturnType<typeof sourceOn>>;

/** A liker `slug`, `at` minutes older than the hour before, profiled in a city of `country`. */
function liker(slug: string, at: number, country: keyof typeof CITIES): Engager {
  const profileUrl = `https://www.linkedin.com/in/${slug}`;
  const person = { providerMemberRef: slug, profileUrl, firstName: "Name", lastName: `of ${slug}` };
  const work = { title: `Head of Sales ${country}`, companyName: "Blue Harbor" };
  fake.seedProfile({
    ...person,
    ...work,
    headline: "Head of Sales",
    locationText: CITIES[country],
  });
  const engagedAt = new Date(stamp - 3_600_000 - at * 60_000);
  const name = `Name of ${slug}`;
  return {
    providerMemberRef: slug,
    profileUrl,
    name,
    headline: "Head of Sales",
    reaction: "like",
    engagedAt,
  };
}

/** A post engagers source on post `n`, its likers a Berliner and a Parisian. */
function likedOn(tenant: Tenant, accountId: string, n: number) {
  const postUrl = `${FEED}activity:${stamp}${n}`;
  fake.seedPost(postUrl, [
    liker(`berlin-${stamp}-${n}`, 0, "DE"),
    liker(`paris-${stamp}-${n}`, 1, "FR"),
  ]);
  return sourceOn(tenant, accountId, "post_engagers", { postUrl });
}

/** A topic source whose search the fake answers with one post of 30 commenters, profiled. */
function commentedTopicOn(tenant: Tenant, accountId: string, n: number) {
  const postUrl = `${FEED}share:${stamp}${n}`;
  const commenters = Array.from({ length: 30 }, (_, i) => {
    const slug = `share-${stamp}-${n}-${i}`;
    const profileUrl = `https://www.linkedin.com/in/${slug}`;
    const work = { title: "Head of Sales", companyName: "Blue Harbor", locationText: "Berlin" };
    const named = { firstName: "Name", lastName: `of ${slug}`, headline: `Headline of ${slug}` };
    fake.seedProfile({ providerMemberRef: `ref-${slug}`, profileUrl, ...named, ...work });
    const engagedAt = new Date(stamp - (i + 1) * 60_000);
    const who = { providerMemberRef: `ref-${slug}`, profileUrl, name: `Name of ${slug}` };
    return {
      ...who,
      headline: "Analyst",
      reaction: "comment" as const,
      engagedAt,
      commentText: "So true",
    };
  });
  fake.seedPost(postUrl, commenters);
  const author = {
    kind: "company" as const,
    companyUrl: "https://www.linkedin.com/company/acme",
    name: "Acme",
  };
  const post: Post = {
    postUrl,
    postedAt: new Date(stamp - 86_400_000),
    excerpt: `Post ${n}`,
    author,
  };
  const phrase = `agent topic ${stamp} ${n}`;
  fake.seedSearch(phrase, [post]);
  const config = { phrase, roles: ["author", "commenter", "reactor"] };
  return sourceOn(tenant, accountId, "topic_engagement", config);
}

/** A topic source whose search the fake answers with no post, with its phrase. */
async function quietTopicOn(tenant: Tenant, accountId: string, n: number) {
  const phrase = `quiet topic ${stamp} ${n}`;
  fake.seedSearch(phrase, []);
  const config = { phrase, roles: ["author", "commenter", "reactor"] };
  return { ...(await sourceOn(tenant, accountId, "topic_engagement", config)), phrase };
}
type Quiet = Awaited<ReturnType<typeof quietTopicOn>>;

/** An active agent on an audience of its own, holding `members`, owned by `ownerUserId`: its id. */
async function agentOf(tenant: Tenant, name: string, members: Source[], ownerUserId?: string) {
  const icpId = await audienceIn(tenant, `${name}'s audience`, []);
  const sourceIds = members.map(({ sourceId }) => sourceId);
  const owner = ownerUserId ?? tenant.user.id;
  const workspaceId = tenant.workspace.id;
  return playbooks.createPlaybook({ workspaceId, icpId, ownerUserId: owner, name, sourceIds });
}

/** The fake's calls through the account, whatever the method, in order. */
const callsOf = (providerAccountRef: string) =>
  fake.recordedCalls.filter(({ input }) => {
    return (input as { providerAccountRef?: unknown }).providerAccountRef === providerAccountRef;
  });

const countsOf = async (runId: string) =>
  (await db().signalRun.findUniqueOrThrow({ where: { id: runId } })).counts;
/** The titles of the workspace's persons, sorted. */
const titlesIn = async (workspaceId: string) =>
  (await db().person.findMany({ where: { workspaceId } })).map(({ title }) => title).sort();
/** The payloads of the workflow's history, decoded. */
async function historyOf(workflowId: string): Promise<string> {
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  const decoded: string[] = [];
  JSON.stringify(JSON.parse(historyToJSON(history)), (_key, value) => {
    const { data, metadata } = (value ?? {}) as { data?: unknown; metadata?: unknown };
    if (typeof data === "string" && metadata) decoded.push(Buffer.from(data, "base64").toString());
    return value;
  });
  return decoded.join("\n");
}

test("a run of a source in an agent drops by that agent's audience: France keeps the Parisian and drops the Berliner, and a source in no agent the reverse by the default's Germany; the history carries the agent's id, never its audience", async (t) => {
  const { tenant, workspaceId, accountId } = await workspaceOf(100);
  await inRun(workspaceId, async (tx) => {
    const { id } = (await icp.readIcpForScoring(workspaceId)).icp;
    await tx.icp.update({ where: { id }, data: { countries: ["DE"] } });
  });
  const france = await audienceIn(tenant, "France", ["FR"]);
  const inAgent = await likedOn(tenant, accountId, 1);
  const inNone = await likedOn(tenant, accountId, 2);
  const playbookId = await playbooks.createPlaybook({
    ...{ workspaceId, icpId: france, ownerUserId: tenant.user.id, name: "France" },
    sourceIds: [inAgent.sourceId],
  });
  linkedin.useClock(() => WEDNESDAY);
  const workflowId = `signals_run-agent-${randomUUID()}`;
  const run = (source: Source, id?: string) =>
    execute<RunResult>("signals_run", { workspaceId, sourceId: source.sourceId }, id);
  const agents = await run(inAgent, workflowId);
  // The run whose history is workflows/__histories__/signals_run_agent.json (history:record).
  t.diagnostic(`signals_run ran as ${workflowId}`);
  const read = { pages: 1, read: 2, staged: 2, profiles_read: 2 };
  assert.equal(agents.status, "done");
  assert.deepEqual(await countsOf(agents.runId), { ...read, created: 1, dropped_filtered: 1 });
  assert.deepEqual(await titlesIn(workspaceId), ["Head of Sales FR"]);
  const history = await historyOf(workflowId);
  assert.ok(history.includes(playbookId), "the history does not name the agent");
  assert.ok(!history.includes(france), "the history names the agent's audience");

  const none = await run(inNone);
  assert.equal(none.status, "done");
  assert.deepEqual(await countsOf(none.runId), { ...read, created: 1, dropped_filtered: 1 });
  assert.deepEqual(await titlesIn(workspaceId), ["Head of Sales DE", "Head of Sales FR"]);
  // Each dropped one leaves its hash with the reason, as before the agents.
  assert.equal(await db().personHash.count({ where: { workspaceId } }), 2);
});

test("the share by agent: an account with one due source in agent A and three in agent B, with 62 reads left, gives A's run 21 reads and each of B's 7; each ends done at its budget and the 20 kept are left (protective rule, beta's read limits)", async () => {
  const { tenant, workspaceId, accountId } = await workspaceOf(62);
  const sources: Source[] = [];
  for (const n of [11, 12, 13, 14]) sources.push(await commentedTopicOn(tenant, accountId, n));
  const [ofA, ...ofB] = sources as [Source, Source, Source, Source];
  for (const [name, members] of [
    ["Agent A", [ofA]],
    ["Agent B", ofB],
  ] as const) {
    const icpId = await audienceIn(tenant, `${name}'s audience`, []);
    const sourceIds = members.map(({ sourceId }) => sourceId);
    await playbooks.createPlaybook({
      workspaceId,
      icpId,
      ownerUserId: tenant.user.id,
      name,
      sourceIds,
    });
  }
  linkedin.useClock(() => WEDNESDAY);
  const tick = await execute("signals_daily_runs_tick", {});
  assert.deepEqual(tick, { workspaces: 2, started: 4 });
  const budgets: (number | null)[] = [];
  for (const { sourceId } of [ofA, ...ofB]) {
    const scheduled = await db().signalRun.findFirstOrThrow({
      where: { sourceId, status: "scheduled" },
    });
    const done = await execute<RunResult>("signals_run", {
      workspaceId,
      sourceId,
      runId: scheduled.id,
    });
    assert.equal(done.status, "done");
    const row = await db().signalRun.findUniqueOrThrow({ where: { id: done.runId } });
    assert.equal((row.counts as Record<string, number>).budget_reached, 1);
    budgets.push(row.readBudget);
  }
  assert.deepEqual(budgets, [21, 7, 7, 7]);
  const day = { senderAccountId: accountId, quotaDay: "2026-10-07" };
  const usage = await db().senderQuotaUsage.findFirstOrThrow({ where: day });
  assert.deepEqual([usage.readsReserved, usage.readsCommitted], [0, 42]);
});

test("a paused agent's source reads nothing at its start, paused by a member or for its owner's removal: a run written before the pause ends cancelled, never started, and a schedule's run writes no row, with no read reserved, no credit and no call to LinkedIn; a source in no agent and an active agent's source run as before (paused-agent-sources)", async () => {
  const { tenant, workspaceId, accountId, providerAccountRef } = await workspaceOf(100);
  const sources: Quiet[] = [];
  for (const n of [21, 22, 23, 24]) sources.push(await quietTopicOn(tenant, accountId, n));
  const [inNone, inActive, inPaused, inRemoved] = sources as [Quiet, Quiet, Quiet, Quiet];
  await agentOf(tenant, "Active", [inActive]);
  const paused = await agentOf(tenant, "Paused", [inPaused]);
  await agentOf(tenant, "Removed", [inRemoved], "usr_leaver");
  linkedin.useClock(() => WEDNESDAY);
  // Written while its agent was active, as Run now or the tick writes one; then the pauses.
  const written = await inRun(workspaceId, () => requestRun(inPaused.sourceId));
  await inRun(workspaceId, async () => {
    await updatePlaybook(paused, { status: "paused" });
    await playbooks.pauseRemovedMember("usr_leaver");
  });
  const calls = callsOf(providerAccountRef).length;
  const run = (source: Source, runId?: string) =>
    execute<RunResult>("signals_run", { workspaceId, sourceId: source.sourceId, runId });

  assert.deepEqual(await run(inPaused, written.id), { runId: written.id, status: "gone" });
  const row = await db().signalRun.findUniqueOrThrow({ where: { id: written.id } });
  assert.deepEqual([row.status, row.startedAt, row.finishedAt !== null], ["cancelled", null, true]);
  // A schedule's run: no runId, no row.
  assert.equal((await run(inRemoved)).status, "gone");
  assert.equal(await db().signalRun.count({ where: { sourceId: inRemoved.sourceId } }), 0);
  assert.equal(
    callsOf(providerAccountRef).length,
    calls,
    "a paused agent's source called LinkedIn",
  );
  const reservations = { where: { senderAccountId: accountId } };
  assert.equal(await db().senderQuotaReservation.count(reservations), 0);
  assert.equal(await db().creditUsage.count(), 0);

  for (const source of [inNone, inActive]) assert.equal((await run(source)).status, "done");
  const searched = callsOf(providerAccountRef).filter(({ method }) => method === "searchPosts");
  const phrases = searched.map(({ input }) => (input as { phrase: string }).phrase);
  assert.deepEqual(phrases, [inNone.phrase, inActive.phrase]);
});

test("the tick writes no run for a paused agent's sources, paused by a member or for its owner's removal, and the share leaves them out: one due source in agent A, active, and three in agent B, paused, with 62 reads left, give A's run 42, what it gets alone; B resumed, the next tick writes B's three runs, A's having run and the removed owner's agent still paused (paused-agent-sources)", async () => {
  const { tenant, workspaceId, accountId } = await workspaceOf(62);
  const sources: Source[] = [];
  for (const n of [31, 32, 33, 34, 35]) sources.push(await quietTopicOn(tenant, accountId, n));
  const [ofA, ofRemoved, ...ofB] = sources as [Source, Source, Source, Source, Source];
  await agentOf(tenant, "Agent A", [ofA]);
  const b = await agentOf(tenant, "Agent B", ofB);
  await agentOf(tenant, "Agent R", [ofRemoved], "usr_leaver");
  await inRun(workspaceId, async () => {
    await updatePlaybook(b, { status: "paused" });
    await playbooks.pauseRemovedMember("usr_leaver");
  });
  linkedin.useClock(() => WEDNESDAY);
  const runsOf = async (source: Source) =>
    (await db().signalRun.findMany({ where: { sourceId: source.sourceId } })).map(
      (run) => run.status,
    );

  assert.deepEqual(await execute("signals_daily_runs_tick", {}), { workspaces: 2, started: 1 });
  for (const source of [ofRemoved, ...ofB]) assert.deepEqual(await runsOf(source), []);
  const scheduled = await db().signalRun.findFirstOrThrow({ where: { sourceId: ofA.sourceId } });
  const input = { workspaceId, sourceId: ofA.sourceId, runId: scheduled.id };
  assert.equal((await execute<RunResult>("signals_run", input)).status, "done");
  const done = await db().signalRun.findUniqueOrThrow({ where: { id: scheduled.id } });
  assert.equal(done.readBudget, 42);

  await inRun(workspaceId, () => updatePlaybook(b, { status: "active" }));
  assert.deepEqual(await execute("signals_daily_runs_tick", {}), { workspaces: 2, started: 3 });
  for (const source of ofB) assert.deepEqual(await runsOf(source), ["scheduled"]);
  assert.deepEqual(await runsOf(ofA), ["done"]);
  assert.deepEqual(await runsOf(ofRemoved), []);
});

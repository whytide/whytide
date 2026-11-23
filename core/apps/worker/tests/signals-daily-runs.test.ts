// signals' daily runs end to end (gamma-p5-040; core/modules/signals/README.md "Runs"), on the
// slice's Temporal and a schema of its database: credits, linkedin and signals loaded from their
// builds by the worker's own loader, their activities through the host's wrapper on one worker of
// the test's queue, on the LinkedIn and files fakes. linkedin's clock (useClock) is the time every
// quota read sees; the test reads no clock. The tick, signals_daily_runs_tick, writes a run of each
// source due as Run now writes one, and the test starts each run as the worker's subscriber does, by
// its id, one after another unless it says otherwise. A run's start takes its account's quota day and
// its share of the day's reads; a read refused for that budget, the cap or the 200 ends its day of
// reading, done with `budget_reached`, its watermark kept; the send path's 20 reads stay free with
// two runs at once; the profiles are read authors and commenters first, then the reactors whose
// headline passes the ICP's titles, then the others.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";
// A run's last step rates its events (gamma-p5-030): no workspace here has an offer to rate against,
// and the LLM port is the fake whatever the slice says.
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
type IcpModule = typeof import("../../../modules/icp/dist/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type Sources = typeof import("../../../modules/signals/dist/domain/sources.js");
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const contacts: ContactsTesting = await built("contacts/dist/testing/index.js");
const { assemblePrices, syncPrices }: CreditsPrices = await built("credits/dist/domain/prices.js");
const { readIcpForScoring }: IcpModule = await built("icp/dist/index.js");
const linkedin: LinkedinTesting = await built("linkedin/dist/testing/index.js");
const { requestRun }: Sources = await built("signals/dist/domain/sources.js");
const signals: SignalsTesting = await built("signals/dist/testing/index.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");
const signalsPrices = new URL("../../../modules/signals/dist/prices.js", import.meta.url).href;
type LinkedinFake = import("@whytide/providers").LinkedinFake;
type Engager = import("@whytide/providers").FakeEngager;
type Post = import("@whytide/providers").LinkedinPost;
type Tenant = Awaited<ReturnType<TenancyTesting["createTwoWorkspaces"]>>[number];
type TenantClient = import("@whytide/db").TenantClient;
type Activity = (input: never) => Promise<unknown>;
type RunResult = { runId: string; status: string; code?: string };
type Tick = { workspaces: number; started: number };

withTestDb();
const env = withTestWorkflowEnvironment();
const db = () => asRole("app");
useCreditsClient(db());
linkedin.useLinkedinClient(db());
tenancy.useTenancyClient(db());
signals.useSignalsClient(db());
contacts.useHashSalt("test-salt-".repeat(4));
linkedin.useSecretKeys(platform.loadMasterKeys({ APP_MASTER_KEY: platform.newMasterKey() }));
const log = platform.createLogger({ destination: platform.collectLogs().destination });
const names = new Set(["credits", "linkedin", "signals"]);
const loaded = await loadModules(moduleLoaders.filter(({ name }) => names.has(name)));
await startModules(loaded, log);
const activities: Record<string, Activity> = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: db(), log })];
  }),
);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal: platform.servicePrincipal("test") }, fn, { client: db() });
/** A working Wednesday and Thursday at 10:00 UTC, the zone of an account unless a test gives one. */
const WEDNESDAY = new Date("2026-10-07T10:00:00.000Z");
const THURSDAY = new Date("2026-10-08T10:00:00.000Z");
const SATURDAY = new Date("2026-10-10T10:00:00.000Z");
const DAY_MS = 86_400_000;
const FEED = "https://www.linkedin.com/feed/update/urn:li:";
const stamp = Date.now();

/** A source's next read reservation held until `release()`; `reached` once its run asks for it. */
const holds = new Map<string, { arrive: () => void; gate: Promise<void> }>();
function hold(sourceId: string) {
  let arrive = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  holds.set(sourceId, { arrive, gate });
  return { reached, release };
}
const signals_reserve_read = async (input: never) => {
  const held = holds.get((input as { sourceId: string }).sourceId);
  if (held !== undefined) {
    holds.delete((input as { sourceId: string }).sourceId);
    held.arrive();
    await held.gate;
  }
  return activities.signals_reserve_read?.(input);
};

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
    activities: { ...activities, signals_reserve_read },
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
/** The daily tick at `at` on linkedin's clock: the counts. */
function tickAt(at: Date): Promise<Tick> {
  linkedin.useClock(() => at);
  return execute<Tick>("signals_daily_runs_tick", {});
}
/** The source's run by its id, as the worker's subscriber starts a run by hand; else as its schedule starts one. */
const runOf = (source: Source, runId?: string, workflowId?: string) => {
  const input = { workspaceId: source.workspaceId, sourceId: source.sourceId };
  return execute<RunResult>("signals_run", runId ? { ...input, runId } : input, workflowId);
};
/** The run the tick wrote of each source, `scheduled`, run to its end in turn. */
async function runScheduled(...sources: Source[]): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const source of sources) {
    const where = { sourceId: source.sourceId, status: "scheduled" as const };
    const scheduled = await db().signalRun.findFirstOrThrow({ where });
    results.push(await runOf(source, scheduled.id));
  }
  return results;
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

/** A connected account of the tenant's workspace the fake knows, in `timeZone`, reading `cap` a day. */
async function accountOf(tenant: Tenant, timeZone = "UTC", cap = 100) {
  const providerAccountRef = `fake-account-${randomUUID()}`;
  fake.emitWebhook("account.connected", providerAccountRef);
  const settings = { providerAccountRef, timeZone };
  const { id } = await linkedin.createConnectedAccount(tenant.workspace.id, settings);
  await capOf(id, cap);
  return id;
}
const capOf = (id: string, dailyReadCap: number) =>
  db().senderAccount.update({ where: { id }, data: { dailyReadCap } });
/** A source of `kind` on the account, enabled unless `enabled` says false. */
async function sourceOn(
  tenant: Tenant,
  accountId: string,
  kind: string,
  config: object,
  enabled = true,
) {
  const workspaceId = tenant.workspace.id;
  const { id } = await db().signalSource.create({
    data: {
      ...{ id: platform.newId("src"), workspaceId, kind, config, label: kind, enabled },
      ...{ senderAccountId: accountId, createdBy: tenant.user.id },
    },
  });
  return { workspaceId, sourceId: id, accountId };
}
type Source = Awaited<ReturnType<typeof sourceOn>>;
let phrases = 0;
/** A topic source on a phrase of its own, whose search the fake answers with `posts`. */
function topicOn(tenant: Tenant, accountId: string, posts: Post[] = [], enabled = true) {
  phrases += 1;
  const phrase = `daily topic ${phrases}`;
  fake.seedSearch(phrase, posts);
  const config = { phrase, roles: ["author", "commenter", "reactor"] };
  return sourceOn(tenant, accountId, "topic_engagement", config, enabled);
}
/** A post engagers source on a post of `count` engagers the fake seeds, none of them profiled. */
function engagersOn(tenant: Tenant, accountId: string, count: number, n: number) {
  const postUrl = `${FEED}activity:${stamp}${n}`;
  const engagers = Array.from({ length: count }, (_, i) => ({
    providerMemberRef: `member-${n}-${i}`,
    profileUrl: `https://www.linkedin.com/in/member-${n}-${i}`,
    name: `Member ${i}`,
    headline: "Head of sales",
    reaction: "like" as const,
    engagedAt: new Date(stamp - 3_600_000 - i * 60_000),
  }));
  fake.seedPost(postUrl, engagers);
  return sourceOn(tenant, accountId, "post_engagers", { postUrl });
}

/** A member `slug`, as a post's author and an engager name them, their profile seeded. */
function member(slug: string) {
  const profileUrl = `https://www.linkedin.com/in/${slug}`;
  const profile = { providerMemberRef: `ref-${slug}`, profileUrl, firstName: "Name" };
  const work = { title: "Head of Sales", companyName: "Blue Harbor", locationText: "Berlin" };
  fake.seedProfile({
    ...profile,
    lastName: `of ${slug}`,
    headline: `Headline of ${slug}`,
    ...work,
  });
  return { providerMemberRef: `ref-${slug}`, profileUrl, name: `Name of ${slug}` };
}
type Member = ReturnType<typeof member>;
/** `who` engaging with `reaction` `ago` ms ago, under `headline`. */
function engaging(who: Member, reaction: Engager["reaction"], ago: number, headline = "Analyst") {
  const words = reaction === "comment" ? { commentText: `Comment of ${who.name}` } : {};
  return { ...who, headline, reaction, engagedAt: new Date(stamp - ago), ...words };
}
const company = {
  kind: "company" as const,
  companyUrl: "https://www.linkedin.com/company/acme",
  name: "Acme",
};
/** Post `n` of a day ago by `author`, its engagers seeded by its unnamed URL. */
function postOf(n: number, engagers: Engager[], author: Post["author"] = company): Post {
  const postUrl = `${FEED}share:${stamp}${n}`;
  fake.seedPost(postUrl, engagers);
  return { postUrl, postedAt: new Date(stamp - DAY_MS), excerpt: `Post ${n}`, author };
}

/** The source's runs, oldest first, each `[status, quota day, read budget, budget_reached]`. */
async function runsOf(source: Source) {
  const rows = await db().signalRun.findMany({
    where: { sourceId: source.sourceId },
    orderBy: { id: "asc" },
  });
  return rows.map(({ status, quotaDay, readBudget, counts }) => {
    const reached = (counts as Record<string, number>).budget_reached ?? 0;
    return [status, quotaDay, readBudget, reached];
  });
}
const usageOf = (senderAccountId: string, quotaDay: string) =>
  db().senderQuotaUsage.findFirstOrThrow({ where: { senderAccountId, quotaDay } });
const countsOf = async (runId: string) =>
  (await db().signalRun.findUniqueOrThrow({ where: { id: runId } })).counts as Record<
    string,
    number
  >;
const watermarkOf = async (source: Source) =>
  (await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } })).watermark;

test("the tick starts each enabled daily source due in its account's window, once a quota day: on New York's Wednesday the topic that has not run, not those that ran that day by Run now or at their save, nor a post engagers source or a disabled topic; on Kolkata's Thursday morning its topic, New York's night closed; on New York's Thursday its three topics again; each run's quota day its account's, its budget its share of what was left", async () => {
  const [ny, kolkata] = await tenancy.createTwoWorkspaces();
  const nyAccount = await accountOf(ny, "America/New_York");
  const inAccount = await accountOf(kolkata, "Asia/Kolkata");
  const due = await topicOn(ny, nyAccount);
  const byHand = await topicOn(ny, nyAccount);
  const atSave = await topicOn(ny, nyAccount);
  const disabled = await topicOn(ny, nyAccount, [], false);
  const engagers = await engagersOn(ny, nyAccount, 0, 1);
  const india = await topicOn(kolkata, inAccount);

  // 10:00 in New York; 19:30 in Kolkata, its window closed.
  const nyWednesday = new Date("2026-10-07T14:00:00.000Z");
  linkedin.useClock(() => nyWednesday);
  const requested = await inRun(byHand.workspaceId, () => requestRun(byHand.sourceId));
  assert.equal((await runOf(byHand, requested.id)).status, "done");
  assert.equal((await runOf(atSave)).status, "done");
  assert.deepEqual(await tickAt(nyWednesday), { workspaces: 2, started: 1 });
  const where = { workspaceId: ny.workspace.id, eventName: "signals.run_requested" };
  const requests = await db().outboxEntry.findMany({ where, orderBy: { id: "asc" } });
  const [scheduled] = await db().signalRun.findMany({ where: { sourceId: due.sourceId } });
  assert.deepEqual(
    requests.map(({ payload }) => payload),
    [
      { source_id: byHand.sourceId, run_id: requested.id },
      { source_id: due.sourceId, run_id: scheduled?.id },
    ],
  );
  await runScheduled(due);
  assert.deepEqual(await tickAt(nyWednesday), { workspaces: 2, started: 0 });

  // Midnight in New York; 09:30 on Thursday in Kolkata.
  assert.deepEqual(await tickAt(new Date("2026-10-08T04:00:00.000Z")), {
    workspaces: 2,
    started: 1,
  });
  await runScheduled(india);
  // 10:00 on Thursday in New York; 19:30 in Kolkata, which ran that day anyway.
  assert.deepEqual(await tickAt(new Date("2026-10-08T14:00:00.000Z")), {
    workspaces: 2,
    started: 3,
  });

  // Each topic read one page of posts, none found. The first two shared 100 with the topics due.
  const wednesday = "2026-10-07";
  const thursday = ["scheduled", null, null, 0];
  assert.deepEqual(await runsOf(byHand), [["done", wednesday, 26, 0], thursday]);
  assert.deepEqual(await runsOf(atSave), [["done", wednesday, 39, 0], thursday]);
  assert.deepEqual(await runsOf(due), [["done", wednesday, 78, 0], thursday]);
  assert.deepEqual(await runsOf(india), [["done", "2026-10-08", 80, 0]]);
  assert.deepEqual([await runsOf(disabled), await runsOf(engagers)], [[], []]);
});

test("nothing starts outside the account's window, with 20 reads or fewer left, under the workspace's or the account's kill switch, or while a run of the source is open; all of them lifted, the source starts", async () => {
  const [tenant] = await tenancy.createTwoWorkspaces();
  const accountId = await accountOf(tenant);
  const source = await topicOn(tenant, accountId);
  const none = { workspaces: 2, started: 0 };
  assert.deepEqual(await tickAt(SATURDAY), none);
  await linkedin.setWorkspaceStopped(source.workspaceId, "tester");
  assert.deepEqual(await tickAt(WEDNESDAY), none);
  await linkedin.setWorkspaceStopped(source.workspaceId, null);
  await linkedin.setAccountPaused(accountId, "tester");
  assert.deepEqual(await tickAt(WEDNESDAY), none);
  await linkedin.setAccountPaused(accountId, null);
  await capOf(accountId, 20);
  assert.deepEqual(await tickAt(WEDNESDAY), none);
  await capOf(accountId, 100);
  const { workspaceId, sourceId } = source;
  const open = await signals.createSignalRun({ workspaceId, sourceId, status: "running" });
  assert.deepEqual(await tickAt(WEDNESDAY), none);
  const ended = { status: "failed" as const, error: "linkedin_account_disconnected" };
  await db().signalRun.update({ where: { id: open.id }, data: ended });
  assert.deepEqual(await tickAt(WEDNESDAY), { workspaces: 2, started: 1 });
  assert.deepEqual(await runsOf(source), [
    ["failed", null, null, 0],
    ["scheduled", null, null, 0],
  ]);
});

test("three daily sources on an account with 62 reads left: the tick starts a run of each, each with a budget of 14, which ends done with budget_reached, its watermark kept, and 20 reads are left after them; the next day the tick starts them again and a run reads on from the same cut, the profiles read the day before dropped as known", async () => {
  await writePrices();
  const [tenant] = await tenancy.createTwoWorkspaces();
  await grantAllowance([tenant.organization.id], 100);
  const accountId = await accountOf(tenant, "UTC", 62);
  const sources: Source[] = [];
  for (const n of [1, 2, 3]) {
    const commenters = Array.from({ length: 30 }, (_, i) =>
      engaging(member(`budget-${n}-${i}`), "comment", (i + 1) * 60_000),
    );
    sources.push(await topicOn(tenant, accountId, [postOf(n, commenters)]));
  }
  assert.deepEqual(await tickAt(WEDNESDAY), { workspaces: 2, started: 3 });
  // A page of posts and two of engagers, then eleven profiles: the twelfth is past the budget.
  const read = { post_pages: 1, posts: 1, pages: 2, read: 30, staged: 30, profiles_read: 11 };
  for (const { runId, status } of await runScheduled(...sources)) {
    assert.equal(status, "done");
    assert.deepEqual(await countsOf(runId), { ...read, created: 11, budget_reached: 1 });
  }
  for (const source of sources) {
    assert.deepEqual(await runsOf(source), [["done", "2026-10-07", 14, 1]]);
    assert.equal(await watermarkOf(source), null);
  }
  const wednesday = await usageOf(accountId, "2026-10-07");
  assert.deepEqual([wednesday.readsReserved, wednesday.readsCommitted], [0, 42]);

  assert.deepEqual(await tickAt(THURSDAY), { workspaces: 2, started: 3 });
  const [next] = await runScheduled(sources[0] as Source);
  assert.equal(next?.status, "done");
  assert.deepEqual(await countsOf(next?.runId ?? ""), {
    ...{ ...read, dropped_known: 11, created: 11, budget_reached: 1 },
  });
  assert.deepEqual((await runsOf(sources[0] as Source))[1], ["done", "2026-10-08", 14, 1]);
  const where = { workspaceId: tenant.workspace.id };
  assert.equal(await db().person.count({ where }), 44);
});

test("protective rule, beta's read limits: two runs at once against 25 reads left leave the send path's 20, the first's budget 5, the second's 2, sharing with the first; each reads its pages to its page limit, then a profile, and ends done with budget_reached, the first refused by the 20 kept; a read refused for the 200 ends the day's reading too", async () => {
  await writePrices();
  const [tenant] = await tenancy.createTwoWorkspaces();
  await grantAllowance([tenant.organization.id], 100);
  const accountId = await accountOf(tenant, "UTC", 25);
  const first = await engagersOn(tenant, accountId, 100, 2);
  const second = await engagersOn(tenant, accountId, 100, 3);
  linkedin.useClock(() => WEDNESDAY);
  const held = hold(first.sourceId);
  const one = runOf(first);
  await held.reached;
  const two = await runOf(second);
  held.release();
  const both = [await one, two];
  assert.deepEqual(
    both.map(({ status }) => status),
    ["done", "done"],
  );
  assert.deepEqual(await runsOf(first), [["done", "2026-10-07", 5, 1]]);
  assert.deepEqual(await runsOf(second), [["done", "2026-10-07", 2, 1]]);
  // Half a budget for the pages, one at least: the second's one page, the first's two.
  assert.equal((await countsOf(two.runId)).pages, 1);
  assert.equal((await countsOf(both[0]?.runId ?? "")).pages, 2);
  const day = await usageOf(accountId, "2026-10-07");
  assert.deepEqual([day.readsReserved, day.readsCommitted], [0, 5]);
  assert.deepEqual([await watermarkOf(first), await watermarkOf(second)], [null, null]);

  // Thursday: the sends took the day's 200 while a run waited for its first read.
  linkedin.useClock(() => THURSDAY);
  const filled = hold(second.sourceId);
  const three = runOf(second);
  await filled.reached;
  const thursday = { senderAccountId: accountId, quotaDay: "2026-10-08" };
  await db().senderQuotaUsage.updateMany({ where: thursday, data: { messagesCommitted: 200 } });
  filled.release();
  assert.equal((await three).status, "done");
  assert.deepEqual((await runsOf(second))[1], ["done", "2026-10-08", 5, 1]);
  const after = await usageOf(accountId, "2026-10-08");
  assert.deepEqual([after.readsReserved, after.readsCommitted], [0, 0]);
  // Each run's profile, which the fake does not know; the first run's fourth read, its second
  // profile's, refused by the 20 kept; the third run's first by the 200.
  const refused = await db().senderActionLog.findMany({
    where: { senderAccountId: accountId, outcome: { notIn: ["reserved", "ok"] } },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    refused.map(({ kind, outcome }) => [kind, outcome]),
    [
      ["read_profile", "linkedin_not_found"],
      ["read_profile", "linkedin_not_found"],
      ["read_profile", "read_cap_reached"],
      ["read_engagers", "daily_actions_cap_reached"],
    ],
  );
});

test("the profiles are read authors and commenters first, then the reactors whose staged headline passes the ICP's titles, then the others: a run whose budget, half of 30 reads less the 20 kept beside a daily source still due, allows three profiles reads the author, the commenter and the fitting reactor, and not the reactor staged before them, whose slot goes back", async () => {
  await writePrices();
  const [tenant] = await tenancy.createTwoWorkspaces();
  const workspaceId = tenant.workspace.id;
  await grantAllowance([tenant.organization.id], 100);
  await inRun(workspaceId, async (tx) => {
    const { id } = (await readIcpForScoring(workspaceId)).icp;
    await tx.icp.update({ where: { id }, data: { titles: ["Head of Sales"] } });
  });
  const accountId = await accountOf(tenant, "UTC", 30);
  await topicOn(tenant, accountId);
  const slugs = ["order-author", "order-barista", "order-seller", "order-commenter"];
  const [author, barista, seller, commenter] = slugs.map(member) as Member[];
  // Newest first, as the page lists them: the reactor who does not fit, the one who does, the
  // commenter; the author is staged before all three.
  const engagers = [
    engaging(barista as Member, "like", 60_000, "Barista at Corner Cafe"),
    engaging(seller as Member, "like", 120_000, "Head of Sales at Blue Harbor"),
    engaging(commenter as Member, "comment", 180_000),
  ];
  const post = postOf(4, engagers, { kind: "member", ...(author as Member), headline: "Founder" });
  const source = await topicOn(tenant, accountId, [post]);
  linkedin.useClock(() => WEDNESDAY);
  const calls = fake.recordedCalls.length;
  const done = await runOf(source, undefined, `signals_run-budget-${randomUUID()}`);
  assert.equal(done.status, "done");
  const profiles = fake.recordedCalls
    .slice(calls)
    .filter(({ method }) => method === "getProfile")
    .map(({ input }) => (input as { profileUrl: string }).profileUrl);
  const first = [author, commenter, seller].map((who) => who?.profileUrl);
  assert.deepEqual(profiles, first);
  assert.deepEqual(await runsOf(source), [["done", "2026-10-07", 5, 1]]);
  assert.deepEqual(await countsOf(done.runId), {
    ...{ post_pages: 1, posts: 1, pages: 1, read: 3, staged: 4, created: 3, profiles_read: 3 },
    budget_reached: 1,
  });
  // Five reads made; the sixth slot the account granted went back.
  const slots = await db().senderQuotaReservation.findMany({
    where: { senderAccountId: accountId },
    orderBy: { id: "asc" },
  });
  const made = slots.map(({ status }) => status);
  assert.deepEqual(made, [...Array(5).fill("committed"), "released"]);
});

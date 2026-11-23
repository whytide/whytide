// signals' posts kinds end to end (gamma-p5-020; core/modules/signals/README.md "Runs", "Processing"),
// on the slice's Temporal and a schema of its database: credits, linkedin and signals loaded from their
// builds by the worker's own loader, their activities through the host's wrapper, on the LinkedIn and
// files fakes, linkedin's clock a working Wednesday at 10:00 UTC (signals-run.test.ts). A topic run
// reads its phrase's posts of the lookback, a page of posts one read, then each post's engagers by its
// unnamed URL, a page one read; the author, the commenters and the reactors staged as the roles keep
// them, each with the post's unnamed URL and excerpt; then the processing, as post engagers' is. An
// own-posts run reads the account's own posts; a competitor's or a creator's, its author's posts
// (gamma-p5-025), and an author LinkedIn does not find fails the run with linkedin_not_found. The
// watermark is each post's newest engagement; a run that fails keeps it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Context } from "@temporalio/activity";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";

const { historyToJSON } = await import("@temporalio/common/lib/proto-utils.js");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { collectLogs, createLogger, loadMasterKeys, newId, newMasterKey } = await import(
  "@whytide/platform"
);
const { getAdapter, linkedinPort } = await import("@whytide/providers");
const { grantAllowance, useCreditsClient } = await import("@whytide/credits/testing");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");

// The modules' test hooks and credits' price list by their builds' paths, as the loader imports them.
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
type ContactsTesting = typeof import("../../../modules/contacts/dist/testing/index.js");
type CreditsPrices = typeof import("../../../modules/credits/dist/domain/prices.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const contacts: ContactsTesting = await built("contacts/dist/testing/index.js");
const { assemblePrices, syncPrices }: CreditsPrices = await built("credits/dist/domain/prices.js");
const linkedin: LinkedinTesting = await built("linkedin/dist/testing/index.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");
const signalsPrices = new URL("../../../modules/signals/dist/prices.js", import.meta.url).href;
type LinkedinFake = import("@whytide/providers").LinkedinFake;
type Engager = import("@whytide/providers").FakeEngager;
type Post = import("@whytide/providers").LinkedinPost;
type RunResult = { runId: string; status: string; code?: string };
type Activity = (input: never) => Promise<unknown>;

withTestDb();
const env = withTestWorkflowEnvironment();
const db = () => asRole("app");
useCreditsClient(db());
linkedin.useLinkedinClient(db());
tenancy.useTenancyClient(db());
contacts.useHashSalt("test-salt-".repeat(4));
linkedin.useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
const log = createLogger({ destination: collectLogs().destination });
const names = new Set(["credits", "linkedin", "signals"]);
const loaded = await loadModules(moduleLoaders.filter(({ name }) => names.has(name)));
await startModules(loaded, log);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: db(), log })];
  }),
);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const WEDNESDAY = new Date("2026-10-07T10:00:00.000Z");
const DAY_MS = 86_400_000;
const PHRASE = "revenue operations";
const FEED = "https://www.linkedin.com/feed/update/urn:li:";

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

/** A workspace with credits, a connected account the fake knows and a source of `kind` on it. */
async function sourceOf(kind: string, config: object, watermark?: object) {
  await writePrices();
  const [tenant] = await tenancy.createTwoWorkspaces();
  const workspaceId = tenant.workspace.id;
  await grantAllowance([tenant.organization.id], 100);
  const providerAccountRef = `fake-account-${randomUUID()}`;
  fake.emitWebhook("account.connected", providerAccountRef);
  const account = await linkedin.createConnectedAccount(workspaceId, { providerAccountRef });
  const source = await db().signalSource.create({
    data: {
      ...{ id: newId("src"), workspaceId, kind, config, label: "Signals", watermark },
      ...{ senderAccountId: account.id, createdBy: tenant.user.id },
    },
  });
  return { workspaceId, sourceId: source.id, accountId: account.id, providerAccountRef };
}
type Source = Awaited<ReturnType<typeof sourceOf>>;

/** A member `slug`, as a post's author and an engager name them, their profile seeded. */
function member(slug: string) {
  const profileUrl = `https://www.linkedin.com/in/${slug}`;
  const [firstName, lastName] = ["Name", `of ${slug}`];
  const profile = { providerMemberRef: `ref-${slug}`, profileUrl, firstName, lastName };
  const headline = `Headline of ${slug}`;
  const work = { title: "Head of Sales", companyName: "Blue Harbor", locationText: "Berlin" };
  fake.seedProfile({ ...profile, headline, ...work });
  return { providerMemberRef: `ref-${slug}`, profileUrl, name: `Name of ${slug}`, headline };
}
const stamp = Date.now();
/** A post `days` ago by `author`, in the form that names its author when `named`, as share `n`. */
function post(n: number, days: number, author: Post["author"], named: boolean): Post {
  const id = `${stamp}${n}`;
  const postUrl = named
    ? `https://www.linkedin.com/posts/author-${n}_revops-share-${id}-AbCd`
    : `${FEED}share:${id}`;
  const postedAt = new Date(Date.now() - days * DAY_MS);
  return { postUrl, postedAt, excerpt: `Post ${n} on revenue operations`, author };
}
const unnamed = (n: number) => `${FEED}share:${stamp}${n}`;
/** `who` engaging with `reaction` `ago` ms ago, dated unless `dateKnown` says false. */
function engaging(who: ReturnType<typeof member>, reaction: Engager["reaction"], ago: number) {
  const words = reaction === "comment" ? { commentText: `Comment of ${who.name}` } : {};
  return { ...who, reaction, engagedAt: new Date(Date.now() - ago), ...words };
}

/** A run; `staging` holds the candidates as the reading left them, before the cheap drops. */
function runOf(source: Source, replaced: Record<string, Activity> = {}) {
  const seen = { rows: [] as Record<string, unknown>[], workflowId: "" };
  const signals_run_start = async (input: never) => {
    seen.workflowId = Context.current().info.workflowExecution?.workflowId ?? "";
    return activities.signals_run_start?.(input);
  };
  const signals_select_candidates = async (input: { runId: string }) => {
    seen.rows = await db().signalCandidate.findMany({
      where: { runId: input.runId },
      orderBy: { id: "asc" },
    });
    return activities.signals_select_candidates?.(input as never);
  };
  const all = { ...activities, signals_run_start, signals_select_candidates, ...replaced };
  const input = { workspaceId: source.workspaceId, sourceId: source.sourceId };
  const result = runWorkflow<RunResult>("signals_run", input, { activities: all });
  return { result, seen };
}
/** Every string the workflow's history holds, its payloads decoded. */
async function historyOf(workflowId: string): Promise<string> {
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  const decoded: string[] = [];
  const raw = JSON.stringify(JSON.parse(historyToJSON(history)), (_key, value) => {
    const data = (value as { metadata?: unknown; data?: unknown } | null)?.data;
    if (typeof data === "string" && (value as { metadata?: unknown }).metadata) {
      decoded.push(Buffer.from(data, "base64").toString("utf8"));
    }
    return value;
  });
  return [raw, ...decoded].join("\n");
}
/** The account's logged reads by kind, `kind:outcome`, oldest first. */
async function readsOf(source: Source) {
  const rows = await db().senderActionLog.findMany({
    where: { senderAccountId: source.accountId },
    orderBy: { id: "asc" },
  });
  return rows.map(({ kind, outcome }) => `${kind}:${outcome}`);
}

test("a topic run reads the phrase's posts of its lookback, then each post's engagers by its unnamed URL: the author, a commenter on two posts and an undated reactor, each a lead with an event per post and evidence naming the unnamed post with its excerpt; the member id under unipile; the watermark per post; the history holds no phrase, profile URL, excerpt or name; a second run reads after each post's cut and drops the known", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const [author, commenter, reactor, later] = ["author-1", "ada", "bo", "cy"].map(member);
  const company = { kind: "company" as const, companyUrl: "https://www.linkedin.com/company/acme" };
  const first = post(1, 2, { kind: "member", ...(author as ReturnType<typeof member>) }, true);
  const second = post(2, 3, { ...company, name: "Acme" }, false);
  fake.seedSearch(PHRASE, [first, second, post(3, 20, { ...company, name: "Acme" }, false)]);
  const ada = commenter as ReturnType<typeof member>;
  const onFirst = [
    engaging(ada, "comment", DAY_MS),
    { ...engaging(reactor!, "like", 0), dateKnown: false },
  ];
  fake.seedPost(unnamed(1), onFirst);
  fake.seedPost(unnamed(2), [engaging(ada, "like", 2 * DAY_MS)]);
  const source = await sourceOf("topic_engagement", {
    phrase: "Revenue  Operations",
    roles: ["author", "commenter", "reactor"],
  });
  const one = runOf(source);
  const done = await one.result;
  assert.equal(done.status, "done");

  const row = await db().signalRun.findUniqueOrThrow({ where: { id: done.runId } });
  assert.deepEqual(row.counts, {
    ...{ post_pages: 1, posts: 2, pages: 2, read: 3, staged: 4 },
    ...{ created: 3, attached: 1, profiles_read: 4 },
  });
  // Each page of posts or engagers, and each profile, one read reserved, then made.
  const kinds = ["read_posts", "read_engagers", "read_engagers", ...Array(4).fill("read_profile")];
  const logged = kinds.flatMap((kind) => [`${kind}:reserved`, `${kind}:ok`]);
  assert.deepEqual(await readsOf(source), logged);
  const reserved = await db().senderQuotaReservation.findMany({
    where: { senderAccountId: source.accountId },
  });
  assert.deepEqual(new Set(reserved.map(({ status }) => status)), new Set(["committed"]));
  assert.equal(reserved.length, 7);
  const staged = one.seen.rows.map((c) => [c.reaction, c.objectUrl, c.postExcerpt, c.commentText]);
  assert.deepEqual(staged, [
    ["author", unnamed(1), null, first.excerpt],
    ["like", unnamed(1), first.excerpt, null],
    ["comment", unnamed(1), first.excerpt, `Comment of ${ada.name}`],
    ["like", unnamed(2), second.excerpt, null],
  ]);
  // The undated reactor is dated at the post's date: a first run has no run before it.
  const undated = one.seen.rows.find((c) => c.reaction === "like" && c.objectUrl === unnamed(1));
  assert.equal((undated?.engagedAt as Date).getTime(), first.postedAt.getTime());

  const where = { workspaceId: source.workspaceId };
  const persons = await db().person.findMany({ where, orderBy: { linkedinUrl: "asc" } });
  assert.deepEqual(
    persons.map((p) => [p.linkedinUrl, (p.providerRefs as Record<string, string>).unipile]),
    ["ada", "author-1", "bo"].map((slug) => [`https://linkedin.com/in/${slug}`, `ref-${slug}`]),
  );
  assert.equal(await db().lead.count({ where }), 3);
  const events = await db().signalEvent.findMany({ where, include: { evidence: true } });
  const shown = events
    .map(({ kind, evidence: [one] }) => [
      kind,
      one?.reaction,
      one?.url,
      one?.excerpt,
      one?.postExcerpt,
    ])
    .sort(
      (a, b) =>
        String(a[1]).localeCompare(String(b[1])) || String(a[2]).localeCompare(String(b[2])),
    );
  assert.deepEqual(shown, [
    ["topic_engagement", "author", unnamed(1), first.excerpt, null],
    ["topic_engagement", "comment", unnamed(1), `Comment of ${ada.name}`, first.excerpt],
    ["topic_engagement", "like", unnamed(1), null, first.excerpt],
    ["topic_engagement", "like", unnamed(2), null, second.excerpt],
  ]);
  const adaEvents = events.filter((e) => e.personId === persons[0]?.id);
  assert.equal(adaEvents.length, 2);
  const saved = await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } });
  const newest = (ago: number) => new Date(Date.now() - ago);
  const marks = (saved.watermark as { posts: Record<string, string> }).posts;
  assert.deepEqual(Object.keys(marks).sort(), [unnamed(1), unnamed(2)]);
  assert.ok(Math.abs(Date.parse(marks[unnamed(1)] ?? "") - newest(DAY_MS).getTime()) < 60_000);
  assert.ok(Math.abs(Date.parse(marks[unnamed(2)] ?? "") - newest(2 * DAY_MS).getTime()) < 60_000);

  const history = await historyOf(one.seen.workflowId);
  const secrets = [PHRASE, "Revenue", "linkedin.com/in/", "linkedin.com/posts/", first.excerpt];
  for (const secret of [...secrets, second.excerpt, ada.name, "Comment of", "Headline of"]) {
    assert.ok(!history.toLowerCase().includes(secret.toLowerCase()), `the history holds ${secret}`);
  }
  assert.ok(history.includes("posts-reader"), "no patch marker");
  assert.ok(history.includes(unnamed(1)));

  fake.seedPost(unnamed(1), [...onFirst, engaging(later!, "comment", 60_000)]);
  const two = runOf(source);
  const again = await two.result;
  assert.equal(again.status, "done");
  const counts = (await db().signalRun.findUniqueOrThrow({ where: { id: again.runId } })).counts;
  assert.deepEqual(counts, {
    ...{ post_pages: 1, posts: 2, pages: 2, read: 4, staged: 4, created: 1 },
    ...{ dropped_known: 3, profiles_read: 1 },
  });
  // The author posted before the first post's cut: not staged again.
  assert.deepEqual(
    two.seen.rows.map((c) => [c.reaction, c.providerMemberRef]),
    [
      ["like", "ref-bo"],
      ["comment", "ref-cy"],
      ["comment", "ref-ada"],
      ["like", "ref-ada"],
    ],
  );
  linkedin.useClock(undefined);
});

test("an own-posts run reads the account's own posts' engagers and keeps no author; a topic of commenters alone keeps neither its authors nor its reactors", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const [owner, ada, bo] = ["owner", "ada-2", "bo-2"].map(member) as ReturnType<typeof member>[];
  const own = await sourceOf("my_post_engagement", {});
  fake.seedOwnPosts(own.providerAccountRef, [post(4, 1, { kind: "member", ...owner! }, false)]);
  fake.seedPost(unnamed(4), [engaging(ada!, "comment", 60_000), engaging(bo!, "repost", 120_000)]);
  // No candidate selected, no profile read: the staging as the last step finds it.
  const staging = { rows: [] as Record<string, unknown>[] };
  const signals_run_end = async (input: { runId: string }) => {
    const where = { runId: input.runId };
    staging.rows = await db().signalCandidate.findMany({ where, orderBy: { id: "asc" } });
    return activities.signals_run_end?.(input as never);
  };
  const signals_select_candidates = async () => ({ candidateIds: [] });
  const pagesOnly = { signals_select_candidates, signals_run_end };
  assert.equal((await runOf(own, pagesOnly).result).status, "done");
  assert.deepEqual(
    staging.rows.map((c) => [c.reaction, c.providerMemberRef, c.objectUrl]),
    [
      ["comment", "ref-ada-2", unnamed(4)],
      ["repost", "ref-bo-2", unnamed(4)],
    ],
  );

  const topic = await sourceOf("topic_engagement", {
    phrase: "pipeline reviews",
    roles: ["commenter"],
  });
  fake.seedSearch("pipeline reviews", [post(5, 1, { kind: "member", ...owner! }, true)]);
  fake.seedPost(unnamed(5), [engaging(ada!, "comment", 60_000), engaging(bo!, "like", 120_000)]);
  assert.equal((await runOf(topic, pagesOnly).result).status, "done");
  assert.deepEqual(
    staging.rows.map((c) => [c.reaction, c.providerMemberRef, c.objectUrl]),
    [["comment", "ref-ada-2", unnamed(5)]],
  );
  linkedin.useClock(undefined);
});

test("a disconnected account ends the run failed with its code at the posts read, that read made; a posts read failing past linkedin's cap ends it failed with the read's code, its read released and the watermark kept", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const disconnected = await sourceOf("my_post_engagement", {});
  fake.failNext(linkedinPort.errors.linkedin_account_disconnected);
  const ended = await runOf(disconnected).result;
  const code = "linkedin_account_disconnected";
  assert.deepEqual(ended, { runId: ended.runId, status: "failed", code });
  const where = (source: Source) => ({ where: { senderAccountId: source.accountId } });
  const made = await db().senderQuotaReservation.findMany(where(disconnected));
  assert.deepEqual(
    made.map(({ status }) => status),
    ["committed"],
  );

  const watermark = { posts: { [unnamed(6)]: "2026-10-01T00:00:00.000Z" } };
  const failing = await sourceOf("my_post_engagement", {}, watermark);
  const details = { method: "listOwnPosts", reason: "unreachable" };
  for (let n = 0; n < 3; n++) fake.failNext(linkedinPort.errors.linkedin_provider_error, details);
  const failed = await runOf(failing).result;
  assert.deepEqual(failed, {
    runId: failed.runId,
    status: "failed",
    code: "linkedin_provider_error",
  });
  const released = await db().senderQuotaReservation.findMany(where(failing));
  assert.deepEqual(
    released.map(({ status }) => status),
    ["released"],
  );
  const kept = await db().signalSource.findUniqueOrThrow({ where: { id: failing.sourceId } });
  assert.deepEqual(kept.watermark, watermark);
  linkedin.useClock(undefined);
});

test("a competitor run reads its page's posts of the lookback through the source's account, then each post's engagers by its unnamed URL, and keeps no author: the engager a lead with a competitor_engagement event and evidence naming the unnamed post with its excerpt; a creator run reads the creator's posts likewise, a creator_engagement event; neither history holds the page, the name or a profile URL", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const [ada, creator, bo] = ["ada-3", "creator-3", "bo-3"].map(member) as ReturnType<
    typeof member
  >[];
  const companyUrl = "https://www.linkedin.com/company/rival-analytics";
  const page = { kind: "company" as const, companyUrl, name: "Rival Analytics" };
  const recent = post(7, 2, page, false);
  fake.seedAuthorPosts(companyUrl, [recent, post(8, 20, page, false)]);
  fake.seedPost(unnamed(7), [engaging(ada!, "comment", DAY_MS)]);
  const rival = await sourceOf("competitor_engagement", {
    companyUrl,
    companyName: "Rival Analytics",
  });
  const one = runOf(rival);
  const done = await one.result;
  assert.equal(done.status, "done");
  const row = await db().signalRun.findUniqueOrThrow({ where: { id: done.runId } });
  assert.deepEqual(row.counts, {
    ...{ post_pages: 1, posts: 1, pages: 1, read: 1, staged: 1, created: 1, profiles_read: 1 },
  });
  const kinds = ["read_posts", "read_engagers", "read_profile"];
  const made = kinds.flatMap((kind) => [`${kind}:reserved`, `${kind}:ok`]);
  assert.deepEqual(await readsOf(rival), made);
  const eventsOf = async (source: Source) => {
    const where = { workspaceId: source.workspaceId };
    const events = await db().signalEvent.findMany({ where, include: { evidence: true } });
    return events.map(({ kind, evidence: [one] }) => [
      kind,
      one?.reaction,
      one?.url,
      one?.excerpt,
      one?.postExcerpt,
    ]);
  };
  assert.deepEqual(await eventsOf(rival), [
    ["competitor_engagement", "comment", unnamed(7), `Comment of ${ada!.name}`, recent.excerpt],
  ]);

  const theirs = post(9, 1, { kind: "member", ...creator! }, true);
  fake.seedAuthorPosts(creator!.profileUrl, [theirs]);
  fake.seedPost(unnamed(9), [engaging(bo!, "like", 60_000)]);
  const followed = await sourceOf("creator_engagement", { profileUrl: creator!.profileUrl });
  const two = runOf(followed);
  assert.equal((await two.result).status, "done");
  assert.deepEqual(
    two.seen.rows.map((c) => [c.reaction, c.providerMemberRef, c.objectUrl]),
    [["like", "ref-bo-3", unnamed(9)]],
  );
  assert.deepEqual(await readsOf(followed), made);
  assert.deepEqual(await eventsOf(followed), [
    ["creator_engagement", "like", unnamed(9), null, theirs.excerpt],
  ]);

  const histories = [await historyOf(one.seen.workflowId), await historyOf(two.seen.workflowId)];
  const secrets = [companyUrl, "Rival Analytics", "linkedin.com/in/", "linkedin.com/posts/"];
  const words = [recent.excerpt, theirs.excerpt, "Comment of", "Name of", "Headline of"];
  for (const history of histories) {
    for (const secret of [...secrets, ...words]) {
      assert.ok(
        !history.toLowerCase().includes(secret.toLowerCase()),
        `the history holds ${secret}`,
      );
    }
  }
  linkedin.useClock(undefined);
});

test("a posts read refused linkedin_not_found, a creator gone or out of the account's sight, ends the run failed with that code, the read made, and keeps the watermark", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const watermark = { posts: { [unnamed(10)]: "2026-10-01T00:00:00.000Z" } };
  const profileUrl = "https://www.linkedin.com/in/gone-creator";
  const gone = await sourceOf("creator_engagement", { profileUrl }, watermark);
  const ended = await runOf(gone).result;
  const code = "linkedin_not_found";
  assert.deepEqual(ended, { runId: ended.runId, status: "failed", code });
  assert.deepEqual(await readsOf(gone), ["read_posts:reserved", `read_posts:${code}`]);
  const where = { where: { senderAccountId: gone.accountId } };
  const made = await db().senderQuotaReservation.findMany(where);
  assert.deepEqual(
    made.map(({ status }) => status),
    ["committed"],
  );
  const run = await db().signalRun.findUniqueOrThrow({ where: { id: ended.runId } });
  assert.deepEqual([run.status, run.error], ["failed", code]);
  const kept = await db().signalSource.findUniqueOrThrow({ where: { id: gone.sourceId } });
  assert.deepEqual(kept.watermark, watermark);
  linkedin.useClock(undefined);
});

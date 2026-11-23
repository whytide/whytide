// linkedin's posts read end to end (gamma-p5-015; core/modules/linkedin/README.md "Worker"), on the
// fakes and the slice's database: each source's pages written at rawKey as postsFile and answered as
// the key, the count and whether a page follows, the next page's cursor read from the previous page's
// file; an author the provider does not know and an account it finds disconnected answered as
// refusals with their rows, a lost session's pause and a kill switch with no call; a rate limit
// failing the attempt, one row per attempt under rawKey and the day's read counted once, and the
// third error's pause refusing the next attempt with no call. On the slice's Temporal, with retry
// unset, the posts read and the engagers read failing every attempt run 3 times, and a run's history
// holds no phrase, author's link, excerpt, name or cursor.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { json } from "node:stream/consumers";
import { test } from "node:test";
import {
  db,
  fake,
  linkedin,
  methods,
  quota,
  type Sender,
  sender,
  THURSDAY,
  useSendTests,
  useTemporal,
  type Wrap,
} from "./fixtures/linkedin-send.ts";

useSendTests();
const temporal = useTemporal();
// After the fixture, which binds the fakes before the providers load.
const { filesPort, getAdapter } = await import("@whytide/providers");
type Posts = typeof import("../../../modules/linkedin/dist/schemas/posts.js");
const { postsFile }: Posts = await import(
  new URL("../../../modules/linkedin/dist/schemas/posts.js", import.meta.url).href
);
const files = await getAdapter(filesPort, "fake");
const PHRASE = "sales automation";
const MEMBER = {
  kind: "member",
  providerMemberRef: "fake-member-ada",
  profileUrl: "https://www.linkedin.com/in/ada-example",
  name: "Ada Example",
  headline: "Head of Growth at Example",
} as const;
const COMPANY = {
  kind: "company",
  companyUrl: "https://www.linkedin.com/company/example-ltd",
  name: "Example Ltd",
} as const;
const SINCE = new Date("2026-10-15T00:00:00Z");
const DAY_MS = 86_400_000;
const POST_URL = "https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000001";

/** A source's posts, oldest first: one the day before SINCE, which no read gives, and three after it. */
const postsOf = (source: number, author: typeof MEMBER | typeof COMPANY) =>
  [-1, 1, 2, 3].map((day) => ({
    postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:7${source}${String(day + 50).padStart(17, "0")}`,
    postedAt: new Date(SINCE.getTime() + day * DAY_MS),
    excerpt: `Post ${source}.${day} on ${PHRASE}`,
    author,
  }));
type Post = ReturnType<typeof postsOf>[number];
type Cursor = { readonly cursor?: string };
const iso = (posts: Post[]) =>
  posts.map((post) => ({ ...post, postedAt: post.postedAt.toISOString() }));
const request = (source: object, limit = 10) => ({
  source,
  postedSince: SINCE.toISOString(),
  limit,
});
const pageKey = () => `raw/signals/posts/${randomUUID()}.json`;

/** The read's input for the request file written and a new page key. */
async function inputOf(a: Sender, body: object) {
  const requestKey = await a.writeFile(body);
  return { workspaceId: a.workspaceId, accountId: a.accountId, requestKey, rawKey: pageKey() };
}

/** The request file written, and its page read at `attempt`: the input and the answer. */
async function readPage(a: Sender, body: object, attempt = 1) {
  const input = await inputOf(a, body);
  return { input, answer: await a.call("linkedin_read_posts", input, attempt) };
}

const pageOf = async (workspaceId: string, key: string) =>
  postsFile.parse(await json((await files.get({ workspaceId, key })).body));

/** The account's read_posts rows, as `outcome callRef`, sorted. */
async function rowsOf(accountId: string): Promise<string[]> {
  const rows = await db().senderActionLog.findMany({ where: { senderAccountId: accountId } });
  for (const row of rows)
    assert.deepEqual([row.kind, row.objectRef, row.count], ["read_posts", null, 1]);
  return rows.map(({ outcome, callRef }) => `${outcome} ${callRef}`).sort();
}

test("each source's pages go to rawKey as postsFile, answered as the key, the count and whether a page follows; the next page's cursor comes from the previous page's file; one ok row a page; an after file of the last page is read_input_invalid with no call", async () => {
  const a = await sender();
  const [search, authored, own] = [postsOf(1, COMPANY), postsOf(2, MEMBER), postsOf(3, MEMBER)];
  fake.seedSearch(PHRASE, search);
  fake.seedAuthorPosts(MEMBER.profileUrl, authored);
  fake.seedOwnPosts(a.ref, own);
  const sources = [
    [{ by: "phrase", phrase: PHRASE }, search],
    [{ by: "author", authorUrl: MEMBER.profileUrl }, authored],
    [{ by: "own" }, own],
  ] as const;
  const keys: string[] = [];
  for (const [source, seeded] of sources) {
    const since = seeded.slice(1).toReversed(); // newest first, without the one before SINCE
    const body = request(source, 2);
    const first = await readPage(a, body);
    const key = (rawKey: string) => `w/${a.workspaceId}/${rawKey}`;
    assert.deepEqual(first.answer, { key: key(first.input.rawKey), count: 2, more: true });
    const page = await pageOf(a.workspaceId, first.input.rawKey);
    assert.deepEqual(page.posts, iso(since.slice(0, 2)));
    assert.ok(page.nextCursor !== null);
    const next = await readPage(a, { ...body, after: first.input.rawKey });
    assert.deepEqual(next.answer, { key: key(next.input.rawKey), count: 1, more: false });
    const last = await pageOf(a.workspaceId, next.input.rawKey);
    assert.deepEqual(last, { posts: iso(since.slice(2)), nextCursor: null });
    const cursors = fake.recordedCalls.slice(-2).map(({ input }) => (input as Cursor).cursor);
    assert.deepEqual(cursors, [undefined, page.nextCursor]);
    const past = await inputOf(a, { ...body, after: next.input.rawKey });
    await assert.rejects(a.call("linkedin_read_posts", past), {
      code: "read_input_invalid",
      details: { fields: ["after"] },
    });
    keys.push(first.input.rawKey, next.input.rawKey);
  }
  assert.deepEqual(
    methods(),
    ["searchPosts", "listAuthorPosts", "listOwnPosts"].flatMap((m) => [m, m]),
  );
  assert.deepEqual(await rowsOf(a.accountId), keys.map((rawKey) => `ok ${rawKey}`).sort());
  const outside = { ...(await inputOf(a, request({ by: "own" }))), rawKey: "exports/posts.json" };
  assert.throws(() => a.call("linkedin_read_posts", outside));
});

test("an author the provider does not know and an account it finds disconnected answer { refused } with their rows; then the lost session's pause, and on another account a kill switch, answer theirs with no call and no row", async () => {
  const a = await sender();
  const unknown = await readPage(
    a,
    request({ by: "author", authorUrl: "https://www.linkedin.com/in/nobody" }),
  );
  assert.deepEqual(unknown.answer, { refused: "linkedin_not_found" });
  fake.seedAuthorPosts(MEMBER.profileUrl, postsOf(2, MEMBER));
  fake.emitWebhook("account.disconnected", a.ref); // the vendor's side, its webhook lost
  const author = request({ by: "author", authorUrl: MEMBER.profileUrl });
  const lost = await readPage(a, author);
  assert.deepEqual(lost.answer, { refused: "linkedin_account_disconnected" });
  const calls = fake.recordedCalls.length;
  assert.deepEqual((await readPage(a, author)).answer, { refused: "account_paused" });
  assert.deepEqual(await rowsOf(a.accountId), [
    `linkedin_account_disconnected ${lost.input.rawKey}`,
    `linkedin_not_found ${unknown.input.rawKey}`,
  ]);

  const b = await sender();
  fake.seedOwnPosts(b.ref, postsOf(3, MEMBER));
  await linkedin.setPlatformControls({ stopped: true });
  assert.deepEqual((await readPage(b, request({ by: "own" }))).answer, {
    refused: "platform_stopped",
  });
  await linkedin.setPlatformControls({ stopped: false });
  await linkedin.setAccountPaused(b.accountId, "operator");
  assert.deepEqual((await readPage(b, request({ by: "own" }))).answer, {
    refused: "account_stopped",
  });
  assert.equal(fake.recordedCalls.length, calls, "no call");
  assert.deepEqual(await rowsOf(b.accountId), []);
});

test("a rate limit fails the attempt with linkedin_rate_limited and the retry reads the page: a row per attempt under rawKey, the day's read reserved and committed once; the third call's error in the hour pauses the account, and the next attempt answers linkedin_rate_limited with no call and no row", async () => {
  const a = await sender();
  fake.seedOwnPosts(a.ref, postsOf(3, MEMBER));
  const reserve = { accountId: a.accountId, count: 1, kind: "read_posts" } as const;
  const reserved = await a.run(() => quota.reserveReads(reserve));
  assert.ok("reservationId" in reserved);
  const input = await inputOf(a, request({ by: "own" }));
  fake.failNext("linkedin_rate_limited");
  await assert.rejects(a.call("linkedin_read_posts", input, 1), { code: "linkedin_rate_limited" });
  const page = { key: `w/${a.workspaceId}/${input.rawKey}`, count: 3, more: false };
  assert.deepEqual(await a.call("linkedin_read_posts", input, 2), page);
  await a.run(() => quota.commitReads(reserved.reservationId, 1));
  const where = { senderAccountId: a.accountId };
  const day = await db().senderQuotaUsage.findFirstOrThrow({ where });
  assert.deepEqual([day.readsReserved, day.readsCommitted], [0, 1]);

  const others = [
    { ...input, rawKey: pageKey() },
    { ...input, rawKey: pageKey() },
  ];
  for (const other of others) {
    fake.failNext("linkedin_rate_limited");
    await assert.rejects(a.call("linkedin_read_posts", other), { code: "linkedin_rate_limited" });
  }
  const { retryAt } = await db().senderAccount.findUniqueOrThrow({ where: { id: a.accountId } });
  assert.ok(retryAt !== null && retryAt > THURSDAY, "paused by the third error");
  const calls = fake.recordedCalls.length;
  const held = await a.call("linkedin_read_posts", others[1] ?? input, 2);
  assert.deepEqual(held, { refused: "linkedin_rate_limited" });
  assert.equal(fake.recordedCalls.length, calls, "no call");
  // The reservation's own row, then one per attempt that called.
  const limited = [input, ...others].map(({ rawKey }) => `linkedin_rate_limited ${rawKey}`);
  const rows = ["reserved null", ...limited, `ok ${input.rawKey}`];
  assert.deepEqual(await rowsOf(a.accountId), rows.sort());
});

test("on the slice's Temporal, retry unset: the posts read and the engagers read failing every attempt run 3 times; a run of the three sources holds no phrase, author's link, excerpt, name or cursor in its history", async () => {
  const a = await sender();
  const [search, authored, own] = [postsOf(1, COMPANY), postsOf(2, MEMBER), postsOf(3, MEMBER)];
  fake.seedSearch(PHRASE, search);
  fake.seedAuthorPosts(MEMBER.profileUrl, authored);
  fake.seedOwnPosts(a.ref, own);
  fake.seedPost(POST_URL, []);
  const seen: number[] = [];
  const failing: Wrap = (run) => async (input, context) => {
    seen.push(context.attempt);
    fake.failNext("linkedin_provider_error");
    return run(input, context);
  };
  const posts = await inputOf(a, request({ by: "own" }));
  const { workspaceId, accountId } = posts;
  const engagers = { workspaceId, accountId, postUrl: POST_URL, limit: 10, rawKey: pageKey() };
  const reads = [
    ["linkedin_read_posts", posts],
    ["linkedin_read_post_engagers", engagers],
  ] as const;
  for (const [activity, input] of reads) {
    await assert.rejects(temporal.probe([{ activity, input }], { [activity]: failing }));
    assert.deepEqual(seen.splice(0), [1, 2, 3], activity);
  }

  const inputs = [
    await inputOf(a, request({ by: "phrase", phrase: PHRASE }, 2)),
    await inputOf(a, request({ by: "author", authorUrl: MEMBER.profileUrl }, 2)),
    await inputOf(a, request({ by: "own" }, 2)),
  ];
  const calls = inputs.map((input) => ({ activity: "linkedin_read_posts", input }));
  const { workflowId, answers } = await temporal.probe(calls);
  const key = (rawKey: string) => `w/${a.workspaceId}/${rawKey}`;
  assert.deepEqual(
    answers,
    inputs.map(({ rawKey }) => ({ key: key(rawKey), count: 2, more: true })),
  );
  const history = await temporal.historyOf(workflowId);
  assert.ok(history.includes(inputs[0]?.rawKey ?? "?"), "the payloads decoded");
  const pages = await Promise.all(inputs.map(({ rawKey }) => pageOf(a.workspaceId, rawKey)));
  const cursors = pages.map(({ nextCursor }) => nextCursor ?? "");
  const excerpts = [...search, ...authored, ...own].map(({ excerpt }) => excerpt);
  const names = [MEMBER.name, MEMBER.profileUrl, MEMBER.headline, COMPANY.name, COMPANY.companyUrl];
  for (const secret of [PHRASE, ...names, ...excerpts, ...cursors]) {
    assert.ok(secret !== "" && !history.includes(secret), secret);
  }
});

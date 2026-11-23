// inbox's reply draft routes end to end (inbox-reply-draft; core/modules/inbox/README.md "The reply
// draft", "API"): the host started with identity and inbox, on the fake authentication adapter, in a
// schema of the worktree's database, answering real HTTP; a write sends the app's Origin and an
// Idempotency-Key. The owner's connected account (linkedin's test hooks), a person whose member id
// contacts knows, their thread and their reply (@whytide/inbox/testing); a Member of the workspace;
// another workspace's thread. The draft's writing is the worker's (core/apps/worker/tests/
// inbox-reply-draft.test.ts): here the row, its event, one current draft per thread and the
// refusals, the draft's end written as the run leaves it. No route calls the LLM or LinkedIn fake.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { addOptOut, createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import {
  getAdapter,
  type LinkedinFake,
  type LlmFake,
  linkedinPort,
  llmPort,
} from "@whytide/providers";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

// inbox and linkedin by their builds' paths, as src/modules.generated.ts loads them
// (inbox-replies.test.ts).
const built = (path: string) =>
  new URL(`../../../../modules/${path}/index.js`, import.meta.url).href;
type InboxTesting = typeof import("../../../modules/inbox/dist/testing/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const inbox: InboxTesting = await import(built("inbox/dist/testing"));
const linkedinTesting: LinkedinTesting = await import(built("linkedin/dist/testing"));
const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
linkedinTesting.useLinkedinClient(app);
useHashSalt("test-salt-".repeat(4));
const linkedin = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const llm = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "inbox", load: () => import(built("inbox/dist")) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

const BRIEF = "Say yes and offer a call on Tuesday or Thursday.";
type Answer = { status: number; replayed: string | null; body: any };

/** A request to …/inbox<path> of the workspace as the user; a POST with the app's Origin and `key`. */
async function send(
  user: string,
  workspaceId: string,
  method: string,
  path: string,
  body?: object,
  key: string | null = randomUUID(),
): Promise<Answer> {
  const cookie = signInAs(user).map(({ name, value }) => `${name}=${value}`);
  const write = method === "GET" ? {} : { origin: APP_ORIGIN };
  const idempotent = method === "POST" && key !== null ? { "idempotency-key": key } : {};
  const json = body === undefined ? {} : { "content-type": "application/json" };
  const headers = { cookie: cookie.join("; "), ...write, ...idempotent, ...json };
  const url = new URL(`/v1/workspaces/${workspaceId}/inbox${path}`, api.url);
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
  return {
    status: res.status,
    replayed: res.headers.get("idempotent-replayed"),
    body: await res.json(),
  };
}
const codeOf = ({ status, body }: Answer) => [status, body.code];

/** The tenant's workspace with a Member, the Owner's connected account and Ana's thread on it. */
async function seeded(tenant: TestTenant) {
  const workspaceId = tenant.workspace.id;
  const owner = tenant.user.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId, role: "Member" });
  const account = await linkedinTesting.createConnectedAccount(workspaceId, { ownerUserId: owner });
  const principal = servicePrincipal("inbox_test");
  const inTenant = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
  const personId = await inTenant(async () => {
    const slug = `ana-${randomUUID()}`;
    const profile = {
      ...{ linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Ana", lastName: "Lead" },
      providerId: `member-${randomUUID()}`,
    };
    const source = { source: "linkedin", provider: "unipile", profile } as const;
    const { person } = await upsertPersonFromSource(source);
    await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "sev_1" } });
    return person.id;
  });
  const thread = { workspaceId, personId, senderAccountId: account.id, ownerUserId: owner };
  const threadId = await inbox.createThread(thread);
  await inbox.createMessage({ workspaceId, threadId, personId, body: "Can we talk next week?" });
  const as = (user: string) => (method: string, path: string, body?: object, key?: string | null) =>
    send(user, workspaceId, method, path, body, key);
  return {
    ...{ workspaceId, personId, threadId, accountId: account.id, inTenant },
    path: `/threads/${threadId}/reply-draft`,
    owner: as(owner),
    member: as(member.id),
    ownerId: owner,
  };
}

/** The workspace's reply drafts, and its inbox.reply_draft_requested events' payloads. */
async function written(workspaceId: string) {
  const drafts = await app.replyDraft.findMany({
    where: { workspaceId },
    orderBy: { requestedAt: "asc" },
    select: {
      ...{ id: true, threadId: true, requestedBy: true, status: true, brief: true },
      ...{ text: true, replacedText: true },
    },
  });
  const events = await app.outboxEntry.findMany({
    where: { workspaceId, eventName: "inbox.reply_draft_requested" },
    orderBy: { createdAt: "asc" },
    select: { payload: true },
  });
  return { drafts, events: events.map(({ payload }) => payload) };
}
/** The draft's end as the worker's run writes it. */
const end = (
  id: string,
  data: { status: "ready"; text: string } | { status: "failed"; errorCode: string },
) => app.replyDraft.update({ where: { id }, data });

test("POST …/threads/{id}/reply-draft: 202 drafting, the owner's row with the brief trimmed, one inbox.reply_draft_requested naming the draft only; the key again answers the same; another press while drafting answers that draft, no second event; GET answers it; no model or LinkedIn call", async () => {
  const [a] = await createTwoWorkspaces();
  const seed = await seeded(a);
  linkedin.reset();
  llm.reset();
  const key = randomUUID();

  assert.deepEqual((await seed.owner("GET", seed.path)).body, {
    ...{ status: "none", text: null, error: null, requestedAt: null },
  });
  const first = await seed.owner("POST", seed.path, { brief: `  ${BRIEF}\n` }, key);

  assert.equal(first.status, 202);
  assert.deepEqual(
    [first.body.status, first.body.text, first.body.error],
    ["drafting", null, null],
  );
  const { drafts, events } = await written(seed.workspaceId);
  assert.equal(drafts.length, 1);
  const [draft] = drafts;
  assert.match(draft?.id ?? "", /^rdr_/);
  assert.deepEqual(
    { ...draft, id: undefined },
    {
      ...{ id: undefined, threadId: seed.threadId, requestedBy: seed.ownerId, status: "drafting" },
      ...{ brief: BRIEF, text: null, replacedText: null },
    },
  );
  assert.deepEqual(events, [{ draftId: draft?.id }]);

  const again = await seed.owner("POST", seed.path, { brief: `  ${BRIEF}\n` }, key);
  assert.deepEqual([again.status, again.replayed, again.body], [202, "true", first.body]);
  const other = await seed.owner("POST", seed.path, { brief: "Another brief." });
  assert.deepEqual([other.status, other.replayed, other.body], [202, null, first.body]);
  assert.deepEqual((await written(seed.workspaceId)).events, [{ draftId: draft?.id }]);
  const read = await seed.owner("GET", seed.path);
  assert.deepEqual([read.status, read.body], [200, first.body]);
  assert.deepEqual([linkedin.recordedCalls, llm.recordedCalls], [[], []]);
});

test("once the draft ended, a press replaces it: a new draft with a new id, the ready text it replaces, a second event; GET answers it ready with its text, then failed with its code; an empty body asks with no brief", async () => {
  const [a] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const { body: first } = await seed.owner("POST", seed.path, { brief: BRIEF });
  const [drafted] = (await written(seed.workspaceId)).drafts;
  const id = drafted?.id ?? "";
  await end(id, { status: "ready", text: "Ana, yes: Tuesday or Thursday?" });
  const ready = await seed.owner("GET", seed.path);
  assert.deepEqual(ready.body, {
    ...{ status: "ready", text: "Ana, yes: Tuesday or Thursday?", error: null },
    requestedAt: first.requestedAt,
  });

  const second = await seed.owner("POST", seed.path, {});
  assert.deepEqual([second.status, second.body.status], [202, "drafting"]);
  const { drafts, events } = await written(seed.workspaceId);
  assert.equal(drafts.length, 1, "one draft per thread");
  const [replacing] = drafts;
  assert.notEqual(replacing?.id, id);
  assert.deepEqual(
    [replacing?.brief, replacing?.replacedText],
    [null, "Ana, yes: Tuesday or Thursday?"],
  );
  assert.deepEqual(events, [{ draftId: id }, { draftId: replacing?.id }]);

  await end(replacing?.id ?? "", { status: "failed", errorCode: "gates_failed" });
  const failed = await seed.owner("GET", seed.path);
  assert.deepEqual(
    [failed.body.status, failed.body.text, failed.body.error],
    ["failed", null, "gates_failed"],
  );
  await seed.owner("POST", seed.path, { brief: BRIEF });
  const [third] = (await written(seed.workspaceId)).drafts;
  assert.deepEqual([third?.status, third?.replacedText], ["drafting", null]);
});

test("another member's thread and another workspace's are 404 thread_not_found, like an unknown one, to the POST and the GET; nothing written", async () => {
  const [a, b] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const theirs = await seeded(b);
  const notFound = [404, "thread_not_found"];

  for (const method of ["POST", "GET"]) {
    const body = method === "POST" ? { brief: BRIEF } : undefined;
    assert.deepEqual(codeOf(await seed.member(method, seed.path, body)), notFound);
    assert.deepEqual(codeOf(await seed.owner(method, theirs.path, body)), notFound);
    const unknown = "/threads/thr_unknown/reply-draft";
    assert.deepEqual(codeOf(await seed.owner(method, unknown, body)), notFound);
  }

  assert.deepEqual(await written(seed.workspaceId), { drafts: [], events: [] });
  assert.deepEqual(await written(theirs.workspaceId), { drafts: [], events: [] });
});

test("refused, nothing written: a brief past REPLY_BRIEF_MAX 400 reply_brief_too_long with its max, trimmed first; another field 400 validation_failed; no key 400; the account disconnected 409 reply_channel_unavailable; the person suppressed 409 person_suppressed with its reason", async () => {
  const [a] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const post = (body: object, key?: string | null) => seed.owner("POST", seed.path, body, key);

  const long = await post({ brief: "x".repeat(2_001) });
  assert.deepEqual(
    [...codeOf(long), long.body.details],
    [400, "reply_brief_too_long", { max: 2000 }],
  );
  assert.deepEqual(codeOf(await post({ brief: BRIEF, text: "Hi" })), [400, "validation_failed"]);
  assert.deepEqual(codeOf(await post({ brief: BRIEF }, null)), [400, "idempotency_key_required"]);
  await app.senderAccount.update({
    where: { id: seed.accountId },
    data: { status: "disconnected" },
  });
  assert.deepEqual(codeOf(await post({ brief: BRIEF })), [409, "reply_channel_unavailable"]);
  await app.senderAccount.update({ where: { id: seed.accountId }, data: { status: "connected" } });
  await seed.inTenant(() =>
    addOptOut(seed.personId, { source: "manual", createdBy: seed.ownerId }),
  );
  const suppressed = await post({ brief: BRIEF });
  assert.deepEqual(
    [...codeOf(suppressed), suppressed.body.details],
    [409, "person_suppressed", { reason: "opted_out" }],
  );

  assert.deepEqual(await written(seed.workspaceId), { drafts: [], events: [] });
  const [b] = await createTwoWorkspaces();
  const fits = await seeded(b);
  const trimmed = await fits.owner("POST", fits.path, { brief: ` ${"x".repeat(2_000)} ` });
  assert.equal(trimmed.status, 202, "trimmed, it fits");
});

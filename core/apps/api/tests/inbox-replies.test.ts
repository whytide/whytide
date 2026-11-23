// inbox's reply route end to end (gamma-p4-060; core/modules/inbox/README.md "Replies from the
// inbox", "API"): the host started with identity and inbox, on the fake authentication adapter, in a
// schema of the worktree's database, answering real HTTP; a write sends the app's Origin and an
// Idempotency-Key. The owner's connected account (linkedin's test hooks), a person whose member id
// contacts knows, their thread and their reply (@whytide/inbox/testing); a Member of the workspace;
// another workspace's thread. The reply's send is the worker's (core/apps/worker/tests/
// inbox-send-reply.test.ts): here the row, its event and the refusals. No route calls the LinkedIn
// fake. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { addOptOut, createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { getAdapter, type LinkedinFake, linkedinPort } from "@whytide/providers";
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

// inbox and linkedin by their builds' paths, as src/modules.generated.ts loads them: the api lists
// no module with a screen (inbox-threads.test.ts).
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

const TEXT = "Thanks Ana, Tuesday at 3 works.";
type Answer = { status: number; replayed: string | null; body: any };

/**
 * A request to …/inbox<path> of the workspace as the user; a POST with the app's Origin and
 * `key`.
 */
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

/**
 * The tenant's workspace with a Member, the Owner's connected account, and Ana's thread on it: her
 * member id known to contacts, her reply in it.
 */
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
  await inbox.createMessage({ workspaceId, threadId, personId, body: "Happy to talk." });
  const as = (user: string) => (method: string, path: string, body?: object, key?: string | null) =>
    send(user, workspaceId, method, path, body, key);
  return {
    ...{ workspaceId, personId, threadId, accountId: account.id, inTenant },
    path: `/threads/${threadId}/replies`,
    owner: as(owner),
    member: as(member.id),
    ownerId: owner,
  };
}

/** The workspace's replies from the inbox, and its inbox.reply_requested events' payloads. */
async function written(workspaceId: string) {
  const replies = await app.message.findMany({
    where: { workspaceId, sendStatus: { not: null } },
    select: {
      id: true,
      direction: true,
      sentBy: true,
      body: true,
      sendStatus: true,
      createdBy: true,
    },
  });
  const events = await app.outboxEntry.findMany({
    where: { workspaceId, eventName: "inbox.reply_requested" },
    select: { payload: true },
  });
  return { replies, events: events.map(({ payload }) => payload) };
}

test("POST …/inbox/threads/{id}/replies: 202 sending, the row the owner's with the text trimmed, one inbox.reply_requested naming the message only; the key again answers the same and writes nothing more; the key with another text 422, none 400; no provider call", async () => {
  const [a] = await createTwoWorkspaces();
  const seed = await seeded(a);
  linkedin.reset();
  const key = randomUUID();

  const first = await seed.owner("POST", seed.path, { text: `  ${TEXT}\n` }, key);

  assert.equal(first.status, 202);
  assert.equal(first.body.status, "sending");
  assert.match(first.body.messageId, /^msg_/);
  const { messageId } = first.body;
  const row = { id: messageId, direction: "out", sentBy: "user", body: TEXT };
  assert.deepEqual(await written(seed.workspaceId), {
    replies: [{ ...row, sendStatus: "sending", createdBy: seed.ownerId }],
    events: [{ messageId }],
  });
  const again = await seed.owner("POST", seed.path, { text: `  ${TEXT}\n` }, key);
  assert.deepEqual([again.status, again.replayed, again.body], [202, "true", first.body]);
  assert.equal((await written(seed.workspaceId)).replies.length, 1, "two presses, one reply");
  assert.deepEqual(codeOf(await seed.owner("POST", seed.path, { text: "Other." }, key)), [
    422,
    "idempotency_key_reused",
  ]);
  assert.deepEqual(codeOf(await seed.owner("POST", seed.path, { text: TEXT }, null)), [
    400,
    "idempotency_key_required",
  ]);
  assert.equal((await written(seed.workspaceId)).replies.length, 1);
  assert.deepEqual(linkedin.recordedCalls, []);
});

test("another member's thread and another workspace's are 404 thread_not_found, like an unknown one; nothing written", async () => {
  const [a, b] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const theirs = await seeded(b);
  const notFound = [404, "thread_not_found"];

  assert.deepEqual(codeOf(await seed.member("POST", seed.path, { text: TEXT })), notFound);
  assert.deepEqual(codeOf(await seed.owner("POST", theirs.path, { text: TEXT })), notFound);
  assert.deepEqual(
    codeOf(await seed.owner("POST", "/threads/thr_unknown/replies", { text: TEXT })),
    notFound,
  );

  assert.deepEqual(await written(seed.workspaceId), { replies: [], events: [] });
  assert.deepEqual(await written(theirs.workspaceId), { replies: [], events: [] });
});

test("refused, nothing written: the person suppressed 409 person_suppressed with its reason; no text or another field 400 validation_failed; past the channel's 400 reply_text_invalid with its max; the account disconnected 409 reply_channel_unavailable", async () => {
  const [a] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const post = (body: object) => seed.owner("POST", seed.path, body);

  assert.deepEqual(codeOf(await post({ text: " \n " })), [400, "validation_failed"]);
  assert.deepEqual(codeOf(await post({ text: TEXT, sendAt: "later" })), [400, "validation_failed"]);
  const long = await post({ text: "x".repeat(1901) });
  assert.deepEqual(
    [...codeOf(long), long.body.details],
    [400, "reply_text_invalid", { max: 1900 }],
  );
  await app.senderAccount.update({
    where: { id: seed.accountId },
    data: { status: "disconnected" },
  });
  assert.deepEqual(codeOf(await post({ text: TEXT })), [409, "reply_channel_unavailable"]);
  await app.senderAccount.update({ where: { id: seed.accountId }, data: { status: "connected" } });
  await seed.inTenant(() =>
    addOptOut(seed.personId, { source: "manual", createdBy: seed.ownerId }),
  );
  const suppressed = await post({ text: TEXT });
  assert.deepEqual(
    [...codeOf(suppressed), suppressed.body.details],
    [409, "person_suppressed", { reason: "opted_out" }],
  );

  assert.deepEqual(await written(seed.workspaceId), { replies: [], events: [] });
});

test("GET …/inbox/threads/{id}: a reply's status and code on its message, none on the others; whether the caller replies: the owner yes; a member reads no thread of the owner's (gamma-p6-060)", async () => {
  const [a] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const { body: reply } = await seed.owner("POST", seed.path, { text: TEXT });

  const owner = await seed.owner("GET", `/threads/${seed.threadId}`);
  const member = await seed.member("GET", `/threads/${seed.threadId}`);

  assert.equal(owner.status, 200);
  assert.deepEqual(
    owner.body.messages.map((message: any) => [
      message.direction,
      message.sendStatus,
      message.errorCode,
    ]),
    [
      ["in", null, null],
      ["out", "sending", null],
    ],
  );
  assert.equal(owner.body.messages.at(-1).id, reply.messageId);
  assert.deepEqual(owner.body.reply, { own: true, channelAvailable: true, textMax: 1900 });
  assert.deepEqual(codeOf(member), [404, "thread_not_found"]);
});

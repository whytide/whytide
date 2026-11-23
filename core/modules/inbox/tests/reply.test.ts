// A reply from the inbox (gamma-p4-060; README.md "Replies from the inbox"), on a schema of the
// worktree's database and the files fake, in tenant runs as the route and the worker's activities
// have them: the route's run, the owner's own thread only, another member's and another workspace's
// answered the same 404; the channel unavailable; the text trimmed and within the channel's; the
// row, the member and the event, ids only; the thread's read, each reply's status and the caller's
// reply state; the settle once sent, the provider's ref and time, an echo stored first removed, the
// echo after it storing nothing, the thread and the touch moved forward; a person erased. The safety
// cases are tests/safety/reply-from-inbox.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { erasePerson } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { isAppError } from "@whytide/platform";
import { erasePerson as eraseMessages } from "../domain/erase.ts";
import { replyStateOf } from "../domain/reply/channel.ts";
import { readThread } from "../domain/threads/queries.ts";
import { OWNER, ownFile } from "./fixtures.ts";
import { human, MEMBER, replyFixture, TEXT, useThursday } from "./reply-fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const now = useThursday();
const WORKSPACE = "wsp_inboxreply";
const r = replyFixture(WORKSPACE);
const other = replyFixture("wsp_inboxreplyother");

const codeOf = (error: unknown) => (isAppError(error) ? error.code : error);
const refusal = (promise: Promise<unknown>) => promise.then(() => "answered", codeOf);
/** The thread as `userId` reads it. */
const read = (threadId: string, userId: string) =>
  withTenant(
    { workspaceId: WORKSPACE, principal: human(userId, WORKSPACE) },
    () => readThread(threadId),
    { client: asRole("app") },
  );

test("the route's run: the owner's reply, trimmed, sending, with the member; its event names the message only", async () => {
  const { threadId, personId } = await r.ready("press");
  const before = await r.eventNames();

  const answer = await r.press(threadId, `  ${TEXT}\n`);

  assert.equal(answer.status, "sending");
  assert.match(answer.messageId, /^msg_/);
  const row = await r.rowOf(answer.messageId);
  assert.deepEqual(
    [row.direction, row.sentBy, row.body, row.sendStatus, row.errorCode, row.createdBy],
    ["out", "user", TEXT, "sending", null, OWNER],
  );
  assert.equal(row.providerMessageRef, null);
  const events = await r.app().outboxEntry.findMany({
    where: { workspaceId: WORKSPACE, eventName: "inbox.reply_requested" },
  });
  assert.deepEqual(
    events.map(({ payload }) => payload),
    [{ messageId: answer.messageId }],
  );
  assert.deepEqual((await r.eventNames()).slice(before.length), ["inbox.reply_requested"]);
  const thread = await r.app().thread.findUniqueOrThrow({ where: { id: threadId } });
  assert.equal(thread.personId, personId);
});

test("another member's thread and another workspace's are 404 thread_not_found, nothing written", async () => {
  const { threadId } = await r.ready("not-own");
  const theirs = await other.ready("not-own-other");
  const before = await r.replies();

  assert.equal(await refusal(r.press(threadId, TEXT, MEMBER)), "thread_not_found");
  assert.equal(await refusal(r.press(theirs.threadId)), "thread_not_found");
  assert.equal(await refusal(r.press("thr_unknown")), "thread_not_found");

  assert.equal(await r.replies(), before);
});

test("the channel unavailable: a thread on another channel than LinkedIn's, the account disconnected or gone, the member id unknown, reply_channel_unavailable; the text empty or past the channel's, reply_text_invalid", async () => {
  const { accountId, personId, threadId } = await r.ready("channel");
  const before = await r.replies();

  // A thread on another channel, which no row holds until the email phase: nothing sends on it.
  const thread = { senderAccountId: accountId, ownerUserId: OWNER, personId };
  const other = await r.run(() => replyStateOf({ ...thread, channel: "email" }, OWNER));
  assert.deepEqual([other.own, other.channelAvailable], [true, false]);
  assert.equal(
    (await r.run(() => replyStateOf({ ...thread, channel: "linkedin" }, OWNER))).channelAvailable,
    true,
  );
  assert.equal(await refusal(r.press(threadId, " \n ")), "reply_text_invalid");
  const long = await r.press(threadId, "x".repeat(1901)).catch((error: unknown) => error);
  assert.deepEqual(
    [codeOf(long), isAppError(long) && long.details],
    ["reply_text_invalid", { max: 1900 }],
  );
  await r.app().person.update({ where: { id: personId }, data: { providerRefs: {} } });
  assert.equal(await refusal(r.press(threadId)), "reply_channel_unavailable");
  const disconnected = { status: "disconnected" as const };
  await r.app().senderAccount.update({ where: { id: accountId }, data: disconnected });
  assert.equal(await refusal(r.press(threadId)), "reply_channel_unavailable");
  await r.app().senderAccount.delete({ where: { id: accountId } });
  assert.equal(await refusal(r.press(threadId)), "reply_channel_unavailable", "the thread's owner");

  assert.equal(await r.replies(), before);
});

test("the thread's read: each reply from the inbox with its status and code, the others with none; the reply state, the owner's own and the channel's; another member's read thread_not_found (gamma-p6-060)", async () => {
  const { accountId, threadId } = await r.ready("read");
  const { messageId } = await r.press(threadId);
  await r.app().message.update({
    where: { id: messageId },
    data: { sendStatus: "refused", errorCode: "outside_working_hours" },
  });

  const owner = await read(threadId, OWNER);

  assert.deepEqual(
    owner.messages.map(({ direction, sendStatus, errorCode }) => [
      direction,
      sendStatus,
      errorCode,
    ]),
    [
      ["in", null, null],
      ["out", "refused", "outside_working_hours"],
    ],
  );
  assert.deepEqual(owner.reply, { own: true, channelAvailable: true, textMax: 1900 });
  assert.equal(await refusal(read(threadId, MEMBER)), "thread_not_found", "the owner's only");
  await r
    .app()
    .senderAccount.update({ where: { id: accountId }, data: { status: "disconnected" } });
  assert.deepEqual((await read(threadId, OWNER)).reply.channelAvailable, false);
});

/** A reply pressed and begun on a new thread, its slot counted as linkedin's send leaves it. */
async function sentReply(slug: string) {
  const ready = await r.ready(slug);
  const { messageId } = await r.press(ready.threadId);
  const begun = await r.begin(messageId);
  assert.ok("channel" in begun);
  const sentAt = new Date(now().getTime() + 5000);
  const refs = await r.sentOut(ready, messageId, sentAt);
  await r.commit(begun.reservationId);
  const answer = { sent: true, stepExecutionId: messageId } as const;
  const input = { messageId, accountId: ready.accountId, reservationId: begun.reservationId };
  const settle = () => r.settle({ ...input, phase: "send", answer, code: null });
  const echo = ownFile(TEXT, { ...refs, sentAt: sentAt.toISOString() });
  const storeEcho = () =>
    r.storeOwn({ personId: ready.personId, senderAccountId: ready.accountId }, echo);
  const outbound = async () =>
    (await r.app().message.findMany({ where: { threadId: ready.threadId, direction: "out" } })).map(
      ({ id, providerMessageRef, sentAt: at }) => [id, providerMessageRef, at],
    );
  return { ...ready, messageId, sentAt, refs, settle, storeEcho, outbound };
}

test("sent: the provider's ref and time on the reply, the thread and the person's touch moved forward; the echo after it stores nothing", async () => {
  const reply = await sentReply("sent");

  assert.deepEqual(await reply.settle(), { status: "sent" });

  const { messageId, refs, sentAt } = reply;
  assert.deepEqual(await reply.outbound(), [[messageId, refs.messageRef, sentAt]]);
  const thread = await r.app().thread.findUniqueOrThrow({ where: { id: reply.threadId } });
  assert.deepEqual(thread.lastMessageAt, sentAt);
  assert.deepEqual(await r.touchOf(reply.personId), sentAt);
  const echo = await reply.storeEcho();
  assert.equal(echo.result.stored, false, "the echo adds no row");
  assert.deepEqual(await reply.outbound(), [[messageId, refs.messageRef, sentAt]]);
});

test("the echo stored first as the user's: removed once the reply is sent, which takes its ref; one row", async () => {
  const reply = await sentReply("echo-first");
  const echo = await reply.storeEcho();
  assert.equal(echo.result.stored, true);
  assert.equal((await reply.outbound()).length, 2);

  assert.deepEqual(await reply.settle(), { status: "sent" });

  const { messageId, refs, sentAt } = reply;
  assert.deepEqual(await reply.outbound(), [[messageId, refs.messageRef, sentAt]]);
  assert.equal(await r.app().thread.count({ where: { personId: reply.personId } }), 1);
});

test("a person erased before the settle: gone, the request file deleted, nothing written back", async () => {
  const { accountId, personId, threadId } = await r.ready("erased");
  const { messageId } = await r.press(threadId);
  const begun = await r.begin(messageId);
  assert.ok("channel" in begun);
  assert.ok(await r.requestOf(messageId));
  await r.run(async () => {
    await eraseMessages(personId);
    await erasePerson(personId);
  });

  const answer = { sent: true, stepExecutionId: messageId } as const;
  const settle = { messageId, accountId, reservationId: begun.reservationId, code: null };
  assert.deepEqual(await r.settle({ ...settle, phase: "send", answer }), { status: "gone" });

  assert.equal(await r.requestOf(messageId), null);
  assert.deepEqual(await r.begin(messageId), { settled: "gone" });
});

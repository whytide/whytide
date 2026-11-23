// campaigns.step_sent's store (domain/store/sent.ts; README.md "The platform's own messages"), on a
// schema of the worktree's database, in tenant runs as the delivery has them: the campaign's message
// in the chat's thread with the approved text, the approver and the approval time, once; a
// follow-up the campaign's mode approved, its frozen text with no approver (gamma-p4-090); the echo
// stored first made the campaign's; a connection request, nothing; a step without its send, its
// approval or its refs, nothing and one line with the step's id only; an erased person, nothing.
// The safety case is tests/safety/tester-touch.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { erasePerson as eraseEnrollments } from "@whytide/campaigns";
import { erasePerson } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { type SentInput, storeSent, useSentLog } from "../domain/store/sent.ts";
import { fixture, OWNER, ownFile } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
// A workspace id the files port takes: the echo runs the activity's body on the files fake.
const f = fixture("wsp_inboxsent");
const logs = collectLogs();
useSentLog(createLogger({ destination: logs.destination }));
const TEXT = "Hi Noor, thanks for connecting. Worth a short call on Thursday?";

const store = (event: SentInput) => f.run(() => storeSent(event, new Date()));
const messagesOf = (personId: string) => f.app().message.findMany({ where: { personId } });

/** A person on the account, a new one unless given, message_1 sent; the step's event. */
async function sentStep(slug: string, account?: string) {
  const senderAccountId = account ?? (await f.account()).id;
  const personId = await f.enrolled(senderAccountId, slug);
  const step = await f.sent(senderAccountId, personId, TEXT);
  const event = { stepExecutionId: step.stepExecutionId, personId, actionType: "message" };
  return { senderAccountId, personId, step, event };
}

test("a sent message step's event stores the campaign's message in the chat's thread, with the approved text, the approver and the approval time; again, nothing", async () => {
  const { senderAccountId, personId, step, event } = await sentStep("sent-first");

  assert.equal(await store(event), "stored");
  assert.equal(await store(event), "repeat");

  const [message, ...more] = await messagesOf(personId);
  assert.deepEqual(more, []);
  assert.deepEqual(
    { ...message, id: undefined, threadId: undefined, receivedAt: undefined },
    {
      ...{ id: undefined, workspaceId: "wsp_inboxsent", threadId: undefined, personId },
      ...{ direction: "out", sentBy: "campaign", stepExecutionId: step.stepExecutionId },
      ...{ body: TEXT, providerMessageRef: step.messageRef, sentAt: step.executedAt },
      ...{ receivedAt: undefined, approvedBy: OWNER, approvedAt: step.approvedAt },
      ...{ optOutMatched: false, ownerNotifiedAt: null },
      ...{ sendStatus: null, errorCode: null, createdBy: null },
    },
  );
  const thread = await f.app().thread.findFirstOrThrow({ where: { personId } });
  assert.equal(message?.threadId, thread.id);
  assert.deepEqual(
    [thread.providerThreadRef, thread.senderAccountId, thread.ownerUserId, thread.lastMessageAt],
    [step.chatRef, senderAccountId, OWNER, step.executedAt],
  );
});

test("a follow-up the campaign's mode approved is stored once with its frozen text, its line included, no approver and the approval time", async () => {
  const senderAccountId = (await f.account()).id;
  const personId = await f.enrolled(senderAccountId, "sent-by-mode");
  const line = "Written with AI assistance and sent without a person's review.";
  const step = await f.sent(senderAccountId, personId, TEXT, new Date(), {
    stepKey: "follow_up_1",
    line,
  });
  const event = { stepExecutionId: step.stepExecutionId, personId, actionType: "message" };

  assert.equal(await store(event), "stored");
  assert.equal(await store(event), "repeat");

  const [message, ...more] = await messagesOf(personId);
  assert.deepEqual(more, []);
  assert.deepEqual(
    [message?.sentBy, message?.stepExecutionId, message?.body],
    ["campaign", step.stepExecutionId, `${TEXT}\n\n${line}`],
  );
  assert.deepEqual([message?.approvedBy, message?.approvedAt], [null, step.approvedAt]);
});

test("the echo stored first as the user's becomes the campaign's when the step's event comes", async () => {
  const { senderAccountId, personId, step, event } = await sentStep("sent-echo-first");
  const echoAt = new Date(step.executedAt.getTime() + 3000);
  const refs = { chatRef: step.chatRef, messageRef: step.messageRef };
  // The provider's copy of the text, which the approved one replaces.
  const file = ownFile(`${TEXT} `, { ...refs, sentAt: echoAt.toISOString() });
  const { result } = await f.storeOwn({ personId, senderAccountId }, file);
  assert.equal(result.stored, true);

  assert.equal(await store(event), "claimed");
  assert.equal(await store(event), "repeat");

  const [message, ...more] = await messagesOf(personId);
  assert.deepEqual(more, []);
  assert.equal(message?.id, result.messageId);
  assert.deepEqual(
    [message?.sentBy, message?.stepExecutionId, message?.body, message?.providerMessageRef],
    ["campaign", step.stepExecutionId, TEXT, step.messageRef],
  );
  assert.deepEqual(
    [message?.approvedBy, message?.approvedAt, message?.sentAt],
    [OWNER, step.approvedAt, echoAt],
  );
});

test("a connection request's event stores nothing", async () => {
  const { personId, event } = await sentStep("sent-invite");

  assert.equal(await store({ ...event, actionType: "invite" }), "skipped");

  assert.deepEqual(await messagesOf(personId), []);
  assert.equal(await f.app().thread.count({ where: { personId } }), 0);
});

test("a step without its send, its approval or its refs stores nothing and logs inbox_sent_message_unmatched with the step's id only", async () => {
  const unsent = await sentStep("sent-unsent");
  await f.app().stepExecution.update({
    where: { id: unsent.step.stepExecutionId },
    data: { status: "executing" },
  });
  const unapproved = await sentStep("sent-unapproved", unsent.senderAccountId);
  await f.app().approvalItem.updateMany({
    where: { stepExecutionId: unapproved.step.stepExecutionId },
    data: { approvedContentHash: "0".repeat(64) },
  });
  const unref = await sentStep("sent-no-refs", unsent.senderAccountId);
  await f.app().senderOutreach.updateMany({
    where: { lastStepExecutionId: unref.step.stepExecutionId },
    data: { lastStepExecutionId: null },
  });
  const cases = [unsent, unapproved, unref];
  logs.raw.length = 0;

  for (const { event } of cases) assert.equal(await store(event), "unmatched");

  for (const { personId } of cases) assert.deepEqual(await messagesOf(personId), []);
  assert.deepEqual(
    logs.lines().map(({ level, code, step_execution_id }) => [level, code, step_execution_id]),
    cases.map(({ event }) => ["error", "inbox_sent_message_unmatched", event.stepExecutionId]),
  );
  for (const line of logs.raw) {
    for (const { step } of cases) {
      for (const secret of [TEXT, step.chatRef, step.messageRef]) {
        assert.ok(!line.includes(secret), "no text and no provider ref in the line");
      }
    }
  }
});

test("the step's event of a person erased since stores nothing", async () => {
  const { personId, event } = await sentStep("sent-erased");
  await f.run(async () => {
    await eraseEnrollments(personId);
    await erasePerson(personId);
  });

  assert.equal(await store(event), "gone");

  assert.deepEqual(await messagesOf(personId), []);
});

// The safety case of the account's own messages (beta-p5-020; README.md "The platform's own
// messages"; RB-9.2.2, one touch a day), on a schema of the worktree's database, through the
// activity's body on the files fake as the worker runs it: a message the tester typed by hand on a
// platform thread moves contacts' last_touch_at to its time, which the gate's one-touch-a-day check
// reads (touched_today), is stored once as the user's and holds nothing; the platform's own
// message's echo stores no second row and records no touch of its own.
import assert from "node:assert/strict";
import test from "node:test";
import { lastTouchAt } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { isAppError } from "@whytide/platform";
import { filesPort, getAdapter } from "@whytide/providers";
import { storeSent } from "../../domain/store/sent.ts";
import { fixture, ownFile } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
// A workspace id the files port takes: the activity's body runs on the files fake.
const WORKSPACE = "wsp_inboxtouch";
const f = fixture(WORKSPACE);
const files = await getAdapter(filesPort, "fake");
const HOUR_MS = 3_600_000;

const touchOf = (personId: string) => f.run(() => lastTouchAt(personId));
/** The person's outbound messages, oldest first, as [sent_by, body, provider ref, sent_at]. */
const outbound = async (personId: string) =>
  (
    await f.app().message.findMany({
      where: { personId, direction: "out" },
      orderBy: { sentAt: "asc" },
    })
  ).map(({ sentBy, body, providerMessageRef, sentAt, threadId }) => ({
    row: [sentBy, body, providerMessageRef, sentAt],
    threadId,
  }));

/** A person whose message_1 the platform sent and the step's event stored: a platform thread. */
async function platformThread(slug: string) {
  const { id: senderAccountId } = await f.account();
  const personId = await f.enrolled(senderAccountId, slug);
  const executedAt = new Date("2026-10-29T09:00:00.000Z");
  const text = "Hi Noor, thanks for connecting. Worth a short call on Thursday?";
  const step = await f.sent(senderAccountId, personId, text, executedAt);
  const event = { stepExecutionId: step.stepExecutionId, personId, actionType: "message" };
  assert.equal(await f.run(() => storeSent(event, new Date())), "stored");
  return { senderAccountId, personId, step };
}

test("a message the tester typed on a platform thread moves the person's last touch to its time; stored once as the user's, nothing held", async () => {
  const { senderAccountId, personId, step } = await platformThread("touch-typed");
  assert.deepEqual(await touchOf(personId), step.executedAt, "the send's touch");
  const steps = await f.stepsOf(personId);
  const typedAt = new Date(step.executedAt.getTime() + 2 * HOUR_MS);
  const text = "Following up by hand: does 3pm suit you?";
  const file = ownFile(text, { chatRef: step.chatRef, sentAt: typedAt.toISOString() });

  const typed = await f.storeOwn({ personId, senderAccountId }, file);
  // The same message again, in a file of its own: what a retry between the commit and the delete reads.
  const again = await f.storeOwn({ personId, senderAccountId }, file);

  const { messageId, ...flags } = typed.result;
  assert.ok(messageId);
  assert.deepEqual(flags, { stored: true, held: false, optOut: false });
  assert.deepEqual(again.result, { stored: false, held: false, optOut: false });
  assert.deepEqual(await touchOf(personId), typedAt, "the typed message is the day's touch");
  const rows = await outbound(personId);
  assert.deepEqual(
    rows.map(({ row }) => row),
    [
      ["campaign", step.text, step.messageRef, step.executedAt],
      ["user", text, file.messageRef, typedAt],
    ],
  );
  assert.equal(new Set(rows.map(({ threadId }) => threadId)).size, 1, "the platform's thread");
  assert.deepEqual(await f.stepsOf(personId), steps, "nothing held");
});

test("the platform's own message's echo stores no second row and records no touch of its own", async () => {
  const { senderAccountId, personId, step } = await platformThread("touch-echo");
  const before = await outbound(personId);
  // The provider's time of the message: seconds after the send's commit, which touched the person.
  const echoAt = new Date(step.executedAt.getTime() + 3000);
  const refs = { chatRef: step.chatRef, messageRef: step.messageRef };
  const file = ownFile(step.text, { ...refs, sentAt: echoAt.toISOString() });

  const { result, fileKey } = await f.storeOwn({ personId, senderAccountId }, file);

  assert.deepEqual(result, { stored: false, held: false, optOut: false });
  assert.deepEqual(await outbound(personId), before, "one row, the campaign's");
  assert.deepEqual(await touchOf(personId), step.executedAt, "the send's touch only");
  await assert.rejects(files.get({ workspaceId: WORKSPACE, key: fileKey }), (error) => {
    return isAppError(error) && error.code === "files_not_found";
  });
});

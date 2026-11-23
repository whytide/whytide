// The safety cases of a reply from the inbox (gamma-p4-060; README.md "Replies from the inbox";
// docs/flows.md "A reply from the inbox"), LinkedIn's, on a schema of the worktree's database and the
// LinkedIn and files fakes: the person's suppression refused at the press and again between the press
// and the call, before any slot; a closed switch refusing with its code, nothing reserved and nothing
// called; one send per press, one slot under the message's id however often the begin runs; and the
// check before a retry: an outcome kept for its check leaves the reply sending, a second run is a
// retry, so linkedin's send activity checks before it calls, and a check's "not sent" fails the
// reply rather than sending it again. linkedin's settle of the slot is written as its send activity
// leaves it (the worker's tests/inbox-send-reply.test.ts runs the activity itself). No model.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { addOptOut } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  openSending,
  setAccountPaused,
  setPlatformControls,
  setWorkspaceStopped,
  useLinkedinClient,
} from "@whytide/linkedin/testing";
import { isAppError } from "@whytide/platform";
import { getAdapter, type LlmFake, llmPort } from "@whytide/providers";
import { OWNER } from "../fixtures.ts";
import { linkedinFake, replyFixture, useThursday } from "../reply-fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const now = useThursday();
const WORKSPACE = "wsp_inboxReplySafety";
const r = replyFixture(WORKSPACE);
const fake = await linkedinFake();
const llm = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const HOUR_MS = 3_600_000;

beforeEach(() => {
  fake.reset();
  llm.reset();
});

/** The code an AppError carries; the rejection otherwise. */
const codeOf = (error: unknown) => (isAppError(error) ? error.code : error);

test("suppressed at the press: person_suppressed with its reason, no reply, no event, no slot", async () => {
  const { personId, threadId } = await r.ready("suppressed-at-press");
  await r.run(() => addOptOut(personId, { source: "manual", createdBy: OWNER }));
  const before = { replies: await r.replies(), events: await r.eventNames() };

  const refused = await r.press(threadId).catch((error: unknown) => error);

  assert.equal(codeOf(refused), "person_suppressed");
  assert.deepEqual(isAppError(refused) && refused.details, { reason: "opted_out" });
  assert.deepEqual({ replies: await r.replies(), events: await r.eventNames() }, before);
  assert.equal(await r.app().senderQuotaReservation.count(), 0);
  assert.deepEqual(fake.recordedCalls, []);
});

test("suppressed between the press and the call: the begin refuses it, the reply refused with person_suppressed, no slot and no request file", async () => {
  const { personId, threadId } = await r.ready("suppressed-after-press");
  const { messageId, status } = await r.press(threadId);
  assert.equal(status, "sending");
  await r.run(() => addOptOut(personId, { source: "manual", createdBy: OWNER }));

  assert.deepEqual(await r.begin(messageId), { settled: "refused" });

  const row = await r.rowOf(messageId);
  assert.deepEqual([row.sendStatus, row.errorCode], ["refused", "person_suppressed"]);
  assert.deepEqual(await r.slotsOf(messageId), [], "nothing reserved");
  assert.equal(await r.requestOf(messageId), null, "no request file");
  assert.deepEqual(fake.recordedCalls, []);
});

const SWITCHES = [
  [
    "sending closed on the instance",
    "sending_closed",
    () => setPlatformControls({ sendingOpen: false }),
    openSending,
  ],
  [
    "the platform's stop",
    "platform_stopped",
    () => setPlatformControls({ stopped: true }),
    () => setPlatformControls({ stopped: false }),
  ],
  [
    "the workspace's stop",
    "workspace_stopped",
    () => setWorkspaceStopped(WORKSPACE, "tester"),
    () => setWorkspaceStopped(WORKSPACE, null),
  ],
] as const;

for (const [name, code, close, open] of SWITCHES) {
  test(`${name} refuses the reply with ${code}: nothing reserved, nothing called`, async () => {
    const { threadId } = await r.ready(code);
    const { messageId } = await r.press(threadId);
    await close();
    try {
      assert.deepEqual(await r.begin(messageId), { settled: "refused" });
    } finally {
      await open();
    }
    const row = await r.rowOf(messageId);
    assert.deepEqual([row.sendStatus, row.errorCode], ["refused", code]);
    assert.deepEqual(await r.slotsOf(messageId), []);
    assert.equal(await r.requestOf(messageId), null);
    assert.deepEqual(fake.recordedCalls, []);
  });
}

test("the account's kill switch refuses the reply with account_stopped: nothing reserved, nothing called", async () => {
  const { accountId, threadId } = await r.ready("account-stopped");
  const { messageId } = await r.press(threadId);
  await setAccountPaused(accountId, "tester");

  assert.deepEqual(await r.begin(messageId), { settled: "refused" });

  const row = await r.rowOf(messageId);
  assert.deepEqual([row.sendStatus, row.errorCode], ["refused", "account_stopped"]);
  assert.deepEqual(await r.slotsOf(messageId), []);
  assert.deepEqual(fake.recordedCalls, []);
});

test("one send per press: one slot under the message's id however often the begin runs; once sent, nothing more", async () => {
  const ready = await r.ready("one-per-press");
  const { accountId, personId, threadId, memberRef } = ready;
  const { messageId } = await r.press(threadId);

  const first = await r.begin(messageId);
  assert.ok("channel" in first);
  assert.deepEqual([first.channel, first.accountId, first.retry], ["linkedin", accountId, false]);
  assert.deepEqual(await r.requestOf(messageId), {
    actionType: "message",
    stepExecutionId: messageId,
    idempotencyKey: messageId,
    personId,
    memberRef,
    text: (await r.rowOf(messageId)).body,
  });
  // The begin again, as a retried activity or a second run: the same slot, and a retry.
  const again = await r.begin(messageId);
  assert.ok("channel" in again);
  assert.deepEqual([again.reservationId, again.retry], [first.reservationId, true]);
  assert.deepEqual(await r.slotsOf(messageId), [[first.reservationId, "reserved"]]);

  const sentAt = new Date(now().getTime() - 1000);
  const refs = await r.sentOut(ready, messageId, sentAt);
  await r.commit(first.reservationId);
  const settle = { messageId, accountId, reservationId: first.reservationId, code: null } as const;
  const answer = { sent: true, stepExecutionId: messageId } as const;
  assert.deepEqual(await r.settle({ ...settle, phase: "send", answer }), { status: "sent" });

  const row = await r.rowOf(messageId);
  assert.deepEqual(
    [row.sendStatus, row.errorCode, row.providerMessageRef, row.sentAt],
    ["sent", null, refs.messageRef, sentAt],
  );
  assert.equal(await r.requestOf(messageId), null, "the file deleted once settled");
  // A settle or a begin again changes nothing and reserves nothing.
  assert.deepEqual(await r.settle({ ...settle, phase: "send", answer }), { status: "sent" });
  assert.deepEqual(await r.begin(messageId), { settled: "sent" });
  assert.deepEqual(await r.slotsOf(messageId), [[first.reservationId, "committed"]]);
  assert.equal(llm.recordedCalls.length, 0, "no model");
});

test("the check before a retry: an outcome kept for its check leaves the reply sending; a second run is a retry; the check's not sent fails it, never a second send", async () => {
  const { accountId, threadId } = await r.ready("check-first");
  const { messageId } = await r.press(threadId);
  const begun = await r.begin(messageId);
  assert.ok("channel" in begun);
  const { reservationId } = begun;
  const settle = { messageId, accountId, reservationId } as const;
  // linkedin_provider_error after the call: the slot kept until checked, the account paused an hour.
  const retryAt = new Date(now().getTime() + HOUR_MS);
  await r.app().senderAccount.update({ where: { id: accountId }, data: { retryAt } });
  const kept = { refused: "linkedin_provider_error" } as const;

  const unknown = await r.settle({ ...settle, phase: "send", answer: kept, code: null });

  assert.equal(unknown.status, "unknown");
  assert.ok("waitMs" in unknown);
  assert.equal(unknown.code, "linkedin_provider_error");
  assert.ok(unknown.waitMs > HOUR_MS && unknown.waitMs <= HOUR_MS + 2 * 60_000, "after retry_at");
  assert.equal((await r.rowOf(messageId)).sendStatus, "sending");
  assert.ok(await r.requestOf(messageId), "the file kept for the check");
  // No answer at all, the attempt lost: unknown too, the slot still held.
  const lost = await r.settle({ ...settle, phase: "send", answer: null, code: null });
  assert.equal(lost.status, "unknown");
  // A second run: the same slot, and a retry, so linkedin's send activity checks before it calls.
  const second = await r.begin(messageId);
  assert.ok("channel" in second);
  assert.deepEqual([second.reservationId, second.retry], [reservationId, true]);
  // The check's read refused: still unknown, the wait until its time.
  const readAt = new Date(now().getTime() + 2 * HOUR_MS).toISOString();
  const refusedRead = { refused: "rate_limited", retryAt: readAt } as const;
  const later = await r.settle({
    ...settle,
    phase: "check",
    answer: refusedRead,
    code: kept.refused,
  });
  assert.ok("waitMs" in later && later.waitMs > 2 * HOUR_MS - 60_000);
  assert.equal((await r.rowOf(messageId)).sendStatus, "sending");
  // The check: not sent, the slot released by it; the reply failed with the send's code.
  await r.release(reservationId);
  const notSent = { outcome: "not_sent", stepExecutionId: messageId } as const;

  const failed = await r.settle({ ...settle, phase: "check", answer: notSent, code: kept.refused });

  assert.deepEqual(failed, { status: "failed" });
  const row = await r.rowOf(messageId);
  assert.deepEqual([row.sendStatus, row.errorCode], ["failed", "linkedin_provider_error"]);
  assert.equal(await r.requestOf(messageId), null);
  assert.deepEqual(await r.begin(messageId), { settled: "failed" }, "never sent again");
  assert.deepEqual(await r.slotsOf(messageId), [[reservationId, "released"]]);
  assert.deepEqual(fake.recordedCalls, []);
});

test("a read of the chat refused before the send: refused with its code, the slot freed here, no file; a refusal at linkedin's gate frees the slot: refused with its code; a port's error that counts it: failed", async () => {
  const { accountId, threadId } = await r.ready("refused-or-failed");
  const press = async () => {
    const { messageId } = await r.press(threadId);
    const begun = await r.begin(messageId);
    assert.ok("channel" in begun);
    return { messageId, accountId, reservationId: begun.reservationId, code: null };
  };
  const unread = await press();
  const capped = { refused: "daily_actions_cap_reached", retryAt: null } as const;
  assert.deepEqual(await r.settle({ ...unread, phase: "read", answer: capped }), {
    status: "refused",
  });
  assert.deepEqual(await r.slotsOf(unread.messageId), [[unread.reservationId, "released"]]);
  assert.equal(await r.requestOf(unread.messageId), null);
  const gated = await press();
  await r.release(gated.reservationId);
  const closed = { refused: "workspace_stopped", retryAt: null } as const;
  assert.deepEqual(await r.settle({ ...gated, phase: "send", answer: closed }), {
    status: "refused",
  });
  const counted = await press();
  await r.commit(counted.reservationId);
  const refused = { refused: "linkedin_send_refused" } as const;
  assert.deepEqual(await r.settle({ ...counted, phase: "send", answer: refused }), {
    status: "failed",
  });

  const read = await r.rowOf(unread.messageId);
  const [one, two] = [await r.rowOf(gated.messageId), await r.rowOf(counted.messageId)];
  assert.deepEqual([read.sendStatus, read.errorCode], ["refused", "daily_actions_cap_reached"]);
  assert.deepEqual([one.sendStatus, one.errorCode], ["refused", "workspace_stopped"]);
  assert.deepEqual([two.sendStatus, two.errorCode], ["failed", "linkedin_send_refused"]);
});

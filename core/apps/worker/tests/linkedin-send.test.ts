// linkedin's send activities end to end (beta-p1-050; core/modules/linkedin README.md "Worker", docs/
// flows.md "The send activities"), on the fakes and the slice's database: each send's success (the
// step's key on the call, the slot committed, one `ok` row naming the step, the refs on the outreach
// row, sentMessageRef), the error map's answers (the slot, retry_at, never a throw), a request file
// that is no send, both checks under a send_check read, and on the slice's Temporal a history that
// holds ids and codes only. The cases a retry or a switch makes are tests/safety/'s.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  db,
  fake,
  later,
  linkedin,
  methods,
  outreach,
  quota,
  reservationOf,
  reserveSend,
  rowsOf,
  sender,
  sends,
  THURSDAY,
  useSendTests,
  useTemporal,
  type Wrap,
} from "./fixtures/linkedin-send.ts";

useSendTests();
const temporal = useTemporal();
const HOUR_MS = 3_600_000;
const NOTE = "Enjoyed your talk on churn";
const outreachOf = (personId: string) =>
  db().senderOutreach.findFirstOrThrow({ where: { personId } });
const accountOf = (id: string) => db().senderAccount.findUniqueOrThrow({ where: { id } });
const sentAs = (step: { stepExecutionId: string }) => ({
  sent: true,
  stepExecutionId: step.stepExecutionId,
});
const keyOf = (call: number) =>
  (sends()[call]?.input as { idempotencyKey?: string }).idempotencyKey;
const ids = (a: { workspaceId: string; accountId: string }) => ({
  workspaceId: a.workspaceId,
  accountId: a.accountId,
});

test("an invite with a note, a message and a withdrawal go out: the step's key on each send, the slot committed, one ok row naming the step, the refs on the outreach row; an empty note is none", async () => {
  const a = await sender();
  const invite = await a.step("invite", { note: NOTE });
  assert.deepEqual(await a.call("linkedin_send_invite", invite.input()), sentAs(invite));
  const { memberRef, idempotencyKey } = invite;
  const input = { providerAccountRef: a.ref, memberRef, note: NOTE, idempotencyKey };
  assert.deepEqual(fake.recordedCalls, [{ method: "sendInvite", input }]);
  assert.equal((await reservationOf(invite.reservationId)).status, "committed");
  assert.deepEqual(await rowsOf(invite.stepExecutionId), ["invite:ok"]);
  const ok = { objectRef: invite.stepExecutionId, outcome: "ok" };
  assert.equal((await db().senderActionLog.findFirstOrThrow({ where: ok })).withNote, true);
  const invited = await outreachOf(invite.personId);
  assert.equal(invited.providerMemberRef, memberRef);
  assert.match(invited.providerInvitationRef ?? "", /^fake-invitation-/);
  assert.ok(invited.invitedAt);
  assert.equal(invited.lastStepExecutionId, invite.stepExecutionId);

  const message = await a.step("message");
  assert.deepEqual(await a.call("linkedin_send_message", message.input()), sentAs(message));
  const messaged = await outreachOf(message.personId);
  assert.equal(keyOf(1), message.idempotencyKey);
  assert.ok(messaged.providerChatRef && messaged.lastMessageRef && messaged.lastSentAt);
  const refs = (sx: string) => a.run(() => outreach.sentMessageRef(sx));
  assert.deepEqual(await refs(message.stepExecutionId), {
    messageRef: messaged.lastMessageRef,
    chatRef: messaged.providerChatRef,
  });
  assert.equal(await refs(invite.stepExecutionId), null, "an invite's step has no message");

  const withdraw = await a.step("withdraw", { personId: invite.personId, memberRef });
  assert.deepEqual(await a.call("linkedin_withdraw_invite", withdraw.input()), sentAs(withdraw));
  const invitationRef = invited.providerInvitationRef;
  const withdrawal = { providerAccountRef: a.ref, invitationRef };
  assert.deepEqual(sends()[2], { method: "withdrawInvite", input: withdrawal });
  const withdrawn = await outreachOf(invite.personId);
  assert.ok(withdrawn.withdrawnAt);
  assert.equal(withdrawn.lastStepExecutionId, withdraw.stepExecutionId);

  const bare = await a.step("invite", { note: "" });
  assert.deepEqual(await a.call("linkedin_send_invite", bare.input()), sentAs(bare));
  assert.equal((sends()[3]?.input as { note?: string }).note, undefined);
  const plain = { objectRef: bare.stepExecutionId, outcome: "ok" };
  assert.equal((await db().senderActionLog.findFirstOrThrow({ where: plain })).withNote, false);
});

test("a 429 answers its retryAfterSec, sets retry_at that far, releases the slot, and the fake records one call: an answer, never a throw", async () => {
  const a = await sender();
  const step = await a.step("invite");
  fake.failNext("linkedin_rate_limited");
  const answer = await a.call("linkedin_send_invite", step.input());
  assert.deepEqual(answer, { refused: "linkedin_rate_limited", retryAfterSec: 60 });
  assert.equal(sends().length, 1);
  assert.equal((await reservationOf(step.reservationId)).status, "released");
  assert.deepEqual((await accountOf(a.accountId)).retryAt, new Date(THURSDAY.getTime() + 60_000));
  assert.deepEqual(await rowsOf(step.stepExecutionId), ["invite:linkedin_rate_limited"]);
});

test("a 5xx or a timeout: retry_at now plus PROVIDER_ERROR_PAUSE_MS, the slot held past it, the next send and read refused rate_limited until then; after it, the next call checks first", async () => {
  const a = await sender();
  const step = await a.step("invite");
  fake.failNext("linkedin_provider_error");
  assert.deepEqual(await a.call("linkedin_send_invite", step.input()), {
    refused: "linkedin_provider_error",
  });
  const until = new Date(THURSDAY.getTime() + HOUR_MS);
  assert.deepEqual((await accountOf(a.accountId)).retryAt, until);
  const held = await reservationOf(step.reservationId);
  assert.deepEqual(
    [held.status, held.expiresAt],
    ["reserved", new Date(until.getTime() + 2 * HOUR_MS)],
  );
  const accountId = a.accountId;
  const next = { accountId, actionType: "message" as const, idempotencyKey: "next-step" };
  const refused = { refused: "rate_limited", retryAt: until };
  assert.deepEqual(await a.run(() => reserveSend(next)), refused);
  const read = { accountId, count: 1, kind: "send_check" as const };
  assert.deepEqual(await a.run(() => quota.reserveReads(read)), refused);

  const b = await sender();
  const timedOut = await b.step("message");
  fake.answerNext("sendMessage", new Error("socket timeout"));
  const answer = await b.call("linkedin_send_message", timedOut.input());
  assert.deepEqual(answer, { refused: "linkedin_error_unmapped" });
  assert.deepEqual((await accountOf(b.accountId)).retryAt, until);
  assert.equal((await reservationOf(timedOut.reservationId)).status, "reserved");

  later(HOUR_MS + 1_000);
  const before = methods().length;
  assert.deepEqual(await a.call("linkedin_send_invite", step.input()), sentAs(step));
  assert.deepEqual(methods().slice(before), ["getRelation", "sendInvite"], "the check first");
});

test("the error map's other answers: refused or not found commit the slot, LinkedIn's limit too, a disconnected account releases it; none sets retry_at", async () => {
  const answers = [
    ["linkedin_send_refused", "committed"],
    ["linkedin_not_found", "committed"],
    ["linkedin_limit_reached", "committed"],
    ["linkedin_account_disconnected", "released"],
  ] as const;
  for (const [code, status] of answers) {
    // An account each: LinkedIn's limit and a disconnect pause theirs (linkedin-health.test.ts),
    // and the limit trips the fleet breaker, lifted here as the operator's reopen leaves it.
    await linkedin.setPlatformControls({ invitesPaused: false });
    const a = await sender();
    const step = await a.step("invite");
    fake.failNext(code);
    assert.deepEqual(await a.call("linkedin_send_invite", step.input()), { refused: code });
    assert.equal((await reservationOf(step.reservationId)).status, status, code);
    assert.deepEqual(await rowsOf(step.stepExecutionId), [`invite:${code}`]);
    assert.equal((await accountOf(a.accountId)).retryAt, null, code);
  }
});

test("a request file that is no send of the activity's, or a withdrawal with no invitation known: linkedin_input_invalid, no call, the step's slot released", async () => {
  const a = await sender();
  const invalid = { refused: "linkedin_input_invalid", retryAt: null };
  const broken = await a.step("invite");
  const requestKey = await a.writeFile({ actionType: "invite", stepExecutionId: "sx_" });
  assert.deepEqual(
    await a.call("linkedin_send_invite", { ...broken.input(), requestKey }),
    invalid,
  );
  assert.equal((await reservationOf(broken.reservationId)).status, "released");

  const other = await a.step("invite");
  assert.deepEqual(await a.call("linkedin_send_message", other.input()), invalid);
  assert.equal((await reservationOf(other.reservationId)).status, "reserved", "an invite's slot");

  const withdraw = await a.step("withdraw");
  assert.deepEqual(await a.call("linkedin_withdraw_invite", withdraw.input()), invalid);
  assert.equal((await reservationOf(withdraw.reservationId)).status, "released");
  assert.deepEqual(await rowsOf(withdraw.stepExecutionId), ["withdraw:linkedin_input_invalid"]);
  assert.deepEqual(sends(), []);
});

test("linkedin_check_sent: sent, committed once; not sent, the slot released; a read refused outside the hours or on a stopped account, no call and the slot held; a port error, the read counted and retry_at set; each counts in the day's reads", async () => {
  const a = await sender();
  const checkOf = (requestKey: string) => ({ ...ids(a), requestKey });
  const out = await a.step("invite");
  const killed = a.killedAfterSend();
  await assert.rejects(a.call("linkedin_send_invite", out.input(), 1, killed), /killed/);
  const sent = { outcome: "sent", stepExecutionId: out.stepExecutionId };
  assert.deepEqual(await a.call("linkedin_check_sent", checkOf(out.requestKey)), sent);
  assert.equal((await reservationOf(out.reservationId)).status, "committed");
  assert.equal((await outreachOf(out.personId)).lastStepExecutionId, out.stepExecutionId);

  const idle = await a.step("invite");
  const notSent = { outcome: "not_sent", stepExecutionId: idle.stepExecutionId };
  assert.deepEqual(await a.call("linkedin_check_sent", checkOf(idle.requestKey)), notSent);
  assert.equal((await reservationOf(idle.reservationId)).status, "released");

  const waiting = await a.step("invite");
  const hoursOf = (workingHours: object) =>
    db().senderAccount.update({ where: { id: a.accountId }, data: { workingHours } });
  const days = [1, 2, 3, 4, 5, 6, 7];
  await hoursOf({ start: "12:00", end: "13:00", days });
  const closed = { refused: "outside_working_hours", retryAt: "2026-10-22T12:00:00.000Z" };
  assert.deepEqual(await a.call("linkedin_check_sent", checkOf(waiting.requestKey)), closed);
  await hoursOf({ start: "00:00", end: "23:59", days });
  await linkedin.setAccountPaused(a.accountId, "tester");
  const stopped = { refused: "account_stopped", retryAt: null };
  assert.deepEqual(await a.call("linkedin_check_sent", checkOf(waiting.requestKey)), stopped);
  assert.equal((await reservationOf(waiting.reservationId)).status, "reserved");
  await linkedin.setAccountPaused(a.accountId, null);

  fake.failNext("linkedin_provider_error");
  const failed = (await a.call("linkedin_check_sent", checkOf(waiting.requestKey))) as object;
  const until = new Date(THURSDAY.getTime() + HOUR_MS);
  assert.deepEqual(failed, { refused: "linkedin_provider_error", retryAt: until.toISOString() });
  assert.equal((await reservationOf(waiting.reservationId)).status, "reserved");
  assert.deepEqual(methods(), ["sendInvite", "getRelation", "getRelation", "getRelation"]);
  const day = await db().senderQuotaUsage.findFirstOrThrow({
    where: { senderAccountId: a.accountId },
  });
  assert.deepEqual([day.readsCommitted, day.readsReserved], [3, 0]);
});

test("linkedin_check_reply: no chat known, no read; after the last send, nothing yet, then the person's message marks the reply", async () => {
  const a = await sender();
  const replyOf = (personId: string) => ({ ...ids(a), personId });
  const stranger = `per_${"0".repeat(26)}`;
  assert.deepEqual(await a.call("linkedin_check_reply", replyOf(stranger)), {
    checked: false,
    replied: false,
  });
  assert.deepEqual([methods(), await rowsOf(stranger)], [[], []]);

  const step = await a.step("message");
  await a.call("linkedin_send_message", step.input());
  await sleep(5);
  const check = () => a.call("linkedin_check_reply", replyOf(step.personId));
  assert.deepEqual(await check(), { checked: true, replied: false });
  fake.emitMessage(a.ref, { memberRef: step.memberRef, text: "Happy to talk" });
  assert.deepEqual(await check(), { checked: true, replied: true });
  const row = await outreachOf(step.personId);
  assert.ok(row.lastInboundAt && row.lastSentAt && row.lastInboundAt > row.lastSentAt);
  assert.equal((await rowsOf(step.personId)).filter((r) => r === "send_check:ok").length, 2);
});

test("on Temporal, the history of the sends and the checks holds ids, codes, booleans, numbers and instants: no key ending in _ref, no note, no text, no ref", async () => {
  const a = await sender();
  const invite = await a.step("invite", { note: NOTE });
  const message = await a.step("message", { text: "A private hello" });
  const limited = await a.step("message");
  const calls = [
    { activity: "linkedin_send_invite", input: invite.input() },
    { activity: "linkedin_send_message", input: message.input() },
    { activity: "linkedin_check_sent", input: { ...ids(a), requestKey: message.requestKey } },
    { activity: "linkedin_check_reply", input: { ...ids(a), personId: message.personId } },
    { activity: "linkedin_send_message", input: limited.input() },
  ];
  // The last send meets the provider's rate limit.
  const limit: Wrap = (run) => (input, context) => {
    const { requestKey } = input as { requestKey: string };
    if (requestKey === limited.requestKey) fake.failNext("linkedin_rate_limited");
    return run(input, context);
  };
  const { workflowId, answers } = await temporal.probe(calls, { linkedin_send_message: limit });
  assert.deepEqual(answers, [
    sentAs(invite),
    sentAs(message),
    { outcome: "sent", stepExecutionId: message.stepExecutionId },
    { checked: true, replied: false },
    { refused: "linkedin_rate_limited", retryAfterSec: 60 },
  ]);
  const history = await temporal.historyOf(workflowId);
  assert.ok(history.includes(invite.stepExecutionId), "the payloads decoded");
  const rows = await db().senderOutreach.findMany({ where: { senderAccountId: a.accountId } });
  const refs = rows.flatMap((row) => [
    row.providerChatRef,
    row.lastMessageRef,
    row.providerInvitationRef,
  ]);
  const secrets = [NOTE, "A private hello", invite.memberRef, message.memberRef, a.ref, ...refs];
  assert.equal(refs.filter((ref) => ref !== null).length, 3);
  for (const secret of secrets) {
    if (secret !== null) assert.equal(history.includes(secret), false, secret);
  }
  assert.doesNotMatch(history, /"\w*(?:_ref|Ref)"\s*:/);
});

// Safety cases of campaigns' sender (beta-p4-020; core/modules/campaigns/README.md "Worker",
// docs/flows.md "The sender"), on the LinkedIn fake, the slice's Temporal and a schema of its
// database (fixtures/campaigns-sender.ts). Each case asserts the fake's recorded sends, one per step
// at most: no send without an approved item and its text in the file; a retry after a send, or a
// step a dead run left, never sent twice; the gate at the claim and right before the call (a
// suppression, a reply, one in the chat only); sending closed and a kill switch; the credits
// released at a refusal and charged once, and a released step waiting on an empty balance; the
// spacing after a stop, a late send or one in flight; a person touched today, or with a step in
// flight, waiting for another day. Since beta-p4-040 no send activity is retried: one killed after
// its call is settled by the next run's check (tests/safety/recovery.test.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  afterSend,
  app,
  contacts,
  DAY_MS,
  fake,
  killedAfterSend,
  linkedin,
  MIN_ACTION_GAP_MS,
  now,
  OWNER,
  rowsOf,
  sender,
  senderStart,
  sends,
  skip,
  slotsOf,
  starts,
  stepOf,
  thenOnce,
  usagesOf,
  useSenderTests,
} from "../fixtures/campaigns-sender.ts";

useSenderTests();
const GAP = MIN_ACTION_GAP_MS as number;
const HOUR_MS = 3_600_000;
const OPT_OUT = { source: "manual", createdBy: OWNER };
const scheduled = (id: string) => stepOf(id).then((row) => [row.status, row.errorCode]);

/** The steps' sends a gap apart at least, each no more than a gap past its time. */
async function assertSpaced(ids: readonly string[]): Promise<void> {
  const rows = await Promise.all(ids.map((id) => stepOf(id)));
  const times = rows.map(({ executedAt, scheduledFor }) => {
    assert.ok(executedAt && scheduledFor);
    const late = executedAt.getTime() - scheduledFor.getTime();
    assert.ok(late >= 0 && late < GAP, `sent ${late} ms past its time`);
    return executedAt.getTime();
  });
  times.sort((a, b) => a - b);
  for (let n = 1; n < times.length; n += 1) {
    const gap = (times[n] ?? 0) - (times[n - 1] ?? 0);
    assert.ok(gap >= GAP, `two sends ${gap} ms apart`);
  }
}

test("no approved item, or a request file whose text is not the approved one: nothing is sent, the holds freed", async () => {
  const s = await sender();
  const bare = await s.lead("no-item");
  await app.stepExecution.update({
    where: { id: bare.steps.connect },
    data: { status: "scheduled", dueAt: new Date(now().getTime() - DAY_MS) },
  });
  await s.place(bare.steps.connect as string);
  const changed = await s.ready("changed", "connect", "Hi Noor, glad to connect");
  const rewrite = thenOnce(() => s.rewriteRequest(changed.id, { note: "Hi Noor, buy now" }));
  const { result } = await s.send({ campaigns_sender_prepare: rewrite });

  assert.deepEqual(sends(), []);
  assert.deepEqual(result, { sent: 0, blocked: 2, refused: 0, end: "no_step" });
  const noItem = await stepOf(bare.steps.connect as string);
  assert.deepEqual([noItem.status, noItem.skipReason], ["skipped", "not_approved"]);
  const edited = await stepOf(changed.id);
  assert.deepEqual([edited.status, edited.skipReason], ["skipped", "content_changed"]);
  assert.deepEqual(await usagesOf(changed.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(changed.id), ["released"]);
  assert.equal(await s.hasRequest(changed.id), false);
});

test("a send killed after the call that went out makes no second call: not retried, the run ends unsettled, and the next run checks first and settles the step sent", async () => {
  const s = await sender();
  const step = await s.ready("retry", "message_1", "Noor, a question on follow-ups");
  const killed = await s.send({ linkedin_send_message: killedAfterSend });
  assert.deepEqual(killed.result, { sent: 0, blocked: 0, refused: 0, end: "unsettled" });
  assert.equal(sends().length, 1);
  assert.equal((await stepOf(step.id)).status, "executing");
  const { result } = await s.send();

  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.equal(sends().length, 1);
  assert.deepEqual(
    (await rowsOf(step.id)).filter((row) => row.startsWith("message:")),
    ["message:ok"],
  );
  assert.equal((await stepOf(step.id)).status, "succeeded");
  assert.deepEqual(await usagesOf(step.id), [":1 committed 1"]);
});

test("a step a dead run left `executing` after its call, put back and placed again: its second claim checks first, no second call", async () => {
  const s = await sender();
  const step = await s.ready("left");
  const { scheduledFor } = await stepOf(step.id);
  // The first run's claim, file and call; its worker died before linkedin's settle.
  const input = { workspaceId: s.workspaceId, stepExecutionId: step.id };
  const claim = (await s.call("campaigns_sender_claim", {
    ...{ ...input, scheduledFor: scheduledFor?.toISOString() },
  })) as { reservationId: string; usageId: string };
  const claimed = { ...input, reservationId: claim.reservationId, usageId: claim.usageId };
  const { requestKey } = (await s.call("campaigns_sender_prepare", claimed)) as {
    requestKey: string;
  };
  const before = sends().length;
  const killed: typeof s.run = (fn) =>
    sends().length > before ? Promise.reject(new Error("killed")) : s.run(fn);
  const send = { ...{ workspaceId: s.workspaceId, accountId: s.accountId }, requestKey };
  await assert.rejects(
    s.call(
      "linkedin_send_invite",
      { ...send, reservationId: claim.reservationId, stepAttempt: 1 },
      killed,
    ),
  );
  assert.equal(sends().length, 1);

  // Back to `scheduled` and placed again, as a recovery that missed the send would leave it, its
  // credits freed: linkedin's own check on the second attempt still finds it.
  await s.releaseUsage(claim.usageId);
  await app.stepExecution.update({
    where: { id: step.id },
    data: { status: "scheduled", creditUsageId: null },
  });
  await s.place(step.id);
  const { result } = await s.send();

  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.equal(sends().length, 1);
  assert.deepEqual(
    (await rowsOf(step.id)).filter((row) => row.startsWith("invite:")),
    ["invite:ok"],
  );
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.attempt], ["succeeded", 2]);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1", ":2 committed 1"]);
});

test("a suppressed person's step is skipped at the claim's gate: no slot, no credits, no call", async () => {
  const s = await sender();
  const step = await s.ready("opted-out");
  await s.run(() => contacts.addOptOut(step.personId, OPT_OUT));
  const { result } = await s.send();

  assert.deepEqual(result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });
  assert.deepEqual(sends(), []);
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.skipReason, row.attempt], ["skipped", "opted_out", 0]);
  assert.deepEqual(await usagesOf(step.id), []);
  assert.deepEqual(await slotsOf(step.id), []);
});

test("a person suppressed, or replying, between the claim and the call: the second gate blocks, the slot and the credits freed, no call", async () => {
  const s = await sender();
  const optedOut = await s.ready("late-opt-out");
  const replied = await s.ready("late-reply");
  const between: Record<string, () => Promise<unknown>> = {
    [optedOut.id]: () => s.run(() => contacts.addOptOut(optedOut.personId, OPT_OUT)),
    [replied.id]: async () => {
      const row = { senderAccountId: s.accountId, personId: replied.personId };
      const { id } = await linkedin.createOutreach(s.workspaceId, row);
      await app.senderOutreach.update({ where: { id }, data: { lastInboundAt: now() } });
    },
  };
  const { result } = await s.send({
    campaigns_sender_prepare: (run) => async (input, context) => {
      const answer = await run(input, context);
      await between[(input as { stepExecutionId: string }).stepExecutionId]?.();
      return answer;
    },
  });

  assert.deepEqual(result, { sent: 0, blocked: 2, refused: 0, end: "no_step" });
  assert.deepEqual(sends(), []);
  const [out, held] = await Promise.all([stepOf(optedOut.id), stepOf(replied.id)]);
  assert.deepEqual([out.status, out.skipReason], ["skipped", "opted_out"]);
  assert.deepEqual([held.status, held.skipReason], ["held", "replied"]);
  for (const id of [optedOut.id, replied.id]) {
    assert.deepEqual(await usagesOf(id), [":1 released 1"]);
    assert.deepEqual(await slotsOf(id), ["released"]);
  }
});

test("a reply in the chat that no webhook delivered holds the message and every pending step of the person: no call", async () => {
  const s = await sender();
  const step = await s.ready("chat-reply", "message_1", "Noor, how do you follow up?");
  const chatRef = `chat-${randomUUID()}`;
  const row = { senderAccountId: s.accountId, personId: step.personId };
  const refs = { providerMemberRef: step.memberRef, providerChatRef: chatRef };
  const { id } = await linkedin.createOutreach(s.workspaceId, { ...row, ...refs });
  const lastSentAt = new Date(now().getTime() - DAY_MS);
  await app.senderOutreach.update({ where: { id }, data: { lastSentAt } });
  fake.emitMessage(s.ref, { memberRef: step.memberRef, chatRef, text: "Thanks, not now" });
  const { result } = await s.send();

  assert.deepEqual(result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });
  assert.deepEqual(sends(), []);
  assert.ok(fake.recordedCalls.some(({ method }) => method === "listRecentMessages"));
  for (const key of ["message_1", "follow_up_1", "follow_up_2"]) {
    const held = await stepOf(step.steps[key] as string);
    assert.deepEqual([held.status, held.skipReason], ["held", "replied"], key);
  }
  const enrollment = await app.enrollment.findUniqueOrThrow({ where: { id: step.enrollmentId } });
  assert.equal(enrollment.status, "replied");
  assert.deepEqual(await usagesOf(step.id), []);
});

test("with sending closed nothing is sent: each step back to `scheduled` with sending_closed, its credits freed, and the run ends", async () => {
  const s = await sender();
  const first = await s.ready("closed-1");
  const second = await s.ready("closed-2");
  await linkedin.setPlatformControls({ sendingOpen: false });

  for (const step of [first, second]) {
    const { result } = await s.send();
    assert.deepEqual(result, { sent: 0, blocked: 0, refused: 1, end: "refused" });
    assert.deepEqual(await scheduled(step.id), ["scheduled", "sending_closed"]);
    assert.equal((await stepOf(step.id)).scheduledFor, null);
    assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  }
  assert.deepEqual(sends(), []);
});

test("a kill switch set between two steps stops the next one: no call, its credits freed", async () => {
  const s = await sender();
  const first = await s.ready("switch-1");
  const second = await s.ready("switch-2", "connect", "", afterSend());
  const stop = thenOnce(() => linkedin.setAccountPaused(s.accountId, "tester"));
  const { result } = await s.send({ campaigns_sender_settle: stop });

  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 1, end: "refused" });
  assert.equal(sends().length, 1);
  assert.equal((await stepOf(first.id)).status, "succeeded");
  assert.deepEqual(await scheduled(second.id), ["scheduled", "account_stopped"]);
  assert.deepEqual(await usagesOf(second.id), [":1 released 1"]);
});

test("credits: released at a refusal, the step placed again and sent with one charge under :1 and :2; a step released, then placed again on an empty balance, is not sent and waits insufficient_credits, no slot taken", async () => {
  const s = await sender(2);
  /** linkedin's retry_at set between the claim and the call: the call's re-read refuses. */
  async function refuse(id: string): Promise<void> {
    const retryAt = new Date(now().getTime() + 10 * 60_000);
    const limit = thenOnce(() =>
      app.senderAccount.update({ where: { id: s.accountId }, data: { retryAt } }),
    );
    const refused = await s.send({ campaigns_sender_prepare: limit });
    assert.deepEqual(refused.result, { sent: 0, blocked: 0, refused: 1, end: "refused" });
    const waiting = await stepOf(id);
    assert.deepEqual([waiting.status, waiting.errorCode], ["scheduled", "rate_limited"]);
    assert.equal(waiting.dueAt?.getTime(), retryAt.getTime());
    assert.deepEqual(await usagesOf(id), [":1 released 1"]);
    await app.senderAccount.update({ where: { id: s.accountId }, data: { retryAt: null } });
  }
  const step = await s.ready("charged");
  await refuse(step.id);
  await s.place(step.id);
  assert.equal((await s.send()).result.sent, 1);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1", ":2 committed 1"]);

  // One credit left: a step released, another sent with that credit, then the first placed again.
  const broke = await s.ready("broke", "connect", "", afterSend());
  await refuse(broke.id);
  await s.ready("last-credit", "connect", "", afterSend());
  assert.equal((await s.send()).result.sent, 1);
  await s.place(broke.id, afterSend());
  const { result } = await s.send();
  assert.deepEqual(result, { sent: 0, blocked: 0, refused: 1, end: "refused" });
  const row = await stepOf(broke.id);
  assert.deepEqual(
    [row.status, row.errorCode, row.scheduledFor, row.attempt],
    ["scheduled", "insufficient_credits", null, 1],
  );
  assert.deepEqual(await usagesOf(broke.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(broke.id), ["released"]);
  assert.equal(sends().length, 2);
});

test("after a two-hour worker stop nothing is sent late; placed again by the plan, the steps go a gap apart, none more than a gap past its time", async () => {
  const s = await sender();
  const at = now().getTime() + 1000;
  const ids: string[] = [];
  for (const [n, slug] of ["stop-1", "stop-2", "stop-3"].entries()) {
    ids.push((await s.ready(slug, "connect", "", new Date(at + n * GAP))).id);
  }
  skip(2 * HOUR_MS);
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(sends(), []);

  assert.deepEqual(await s.plan(), { accounts: 1, placed: 3 });
  assert.deepEqual(starts, [senderStart(s.workspaceId, s.accountId)]);
  assert.equal((await s.send()).result.sent, 3);
  assert.equal(sends().length, 3);
  await assertSpaced(ids);
});

test("spacing on the sender's own: steps closer than a gap, as two plans may leave them, or one kept 30 s late go a gap apart; one whose time passes a gap while a send is in flight is left for the plan", async () => {
  const s = await sender();
  const at = now().getTime();
  const late = await s.ready("late", "connect", "", new Date(at - 30_000));
  const close = await s.ready("close", "connect", "", new Date(at + 10_000));
  assert.equal((await s.send()).result.sent, 2);
  await assertSpaced([late.id, close.id]);

  const other = await sender();
  const slow = await other.ready("slow");
  const passed = await other.ready("passed", "connect", "", new Date(now().getTime() + GAP));
  const inFlight = thenOnce(() => skip(GAP + 10_000));
  const { result } = await other.send({ linkedin_send_invite: inFlight });
  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.equal((await stepOf(slow.id)).status, "succeeded");
  const left = await stepOf(passed.id);
  assert.deepEqual([left.status, left.attempt], ["scheduled", 0]);
  assert.ok(left.scheduledFor, "still placed: the plan places it again");
  assert.equal(sends().length, 3);
});

test("a person touched today, or with a step in flight, waits for another day; the next day the step goes and its code is cleared", async () => {
  const s = await sender();
  const touched = await s.lead("touched");
  await s.approve(touched.steps.connect as string, "");
  await s.place(touched.steps.connect as string);
  await s.approve(touched.steps.message_1 as string, "Noor, one question");
  await s.place(touched.steps.message_1 as string, afterSend());
  // An acceptance's message_1 due while the connection request is in flight (a dead run's), its
  // check not due before tomorrow (beta-p4-040).
  const flying = await s.ready("in-flight", "message_1", "Noor, hello", afterSend(2));
  const dueAt = new Date(now().getTime() + 2 * DAY_MS);
  await app.stepExecution.update({
    where: { id: flying.steps.connect },
    data: { status: "executing", attempt: 1, executedAt: null, dueAt },
  });
  const { result } = await s.send();

  assert.deepEqual(result, { sent: 1, blocked: 2, refused: 0, end: "no_step" });
  assert.deepEqual(
    sends().map(({ method }) => method),
    ["sendInvite"],
  );
  const waits = [
    [touched.steps.message_1 as string, "touched_today"],
    [flying.id, "send_in_flight"],
  ] as const;
  for (const [id, code] of waits) {
    const row = await stepOf(id);
    assert.deepEqual([row.status, row.errorCode, row.scheduledFor], ["scheduled", code, null]);
  }

  skip(DAY_MS);
  fake.seedRelation(s.ref, touched.memberRef);
  await s.place(touched.steps.message_1 as string);
  assert.equal((await s.send()).result.sent, 1);
  const sent = await stepOf(touched.steps.message_1 as string);
  assert.deepEqual([sent.status, sent.errorCode], ["succeeded", null]);
  assert.equal(sends().length, 2);
});

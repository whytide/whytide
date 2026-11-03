// The approval's safety cases (beta-p3-050; docs/security.md), run by `pnpm -F campaigns test:safety`
// and not by `test`, on the worktree's database in this file's schema: no step reaches `scheduled`
// without its approved item, and the gate refuses a scheduled step without one (not_approved) or one
// whose text changed after the approval (content_changed), the step skipped and nothing reserved; a
// held or cancelled step's pending item is blocked in the stop's transaction, and an approval pressed
// before the stop passes nothing; a withdrawal needs no item, and every other action needs one, an
// action added later included. A late press's 409 is the worker's test
// (core/apps/worker/tests/campaigns-queue.test.ts): approvals' commands are its routes' only.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { addOptOut } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { reserveSend } from "@whytide/linkedin";
import { openSending, useClock, useLinkedinClient, useRandom } from "@whytide/linkedin/testing";
import { checkGate } from "../../domain/gate/gate.ts";
import { exitSuppressedEnrollments } from "../../domain/gate/suppressed.ts";
import { holdForReply } from "../../domain/hold.ts";
import { needsApproval, opensItem } from "../../domain/steps/actions.ts";
import { nextDueAt } from "../../domain/template/due.ts";
import { fixture } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
// linkedin's reservation reads its own clock: a Wednesday morning, inside the account's hours.
useClock(() => new Date("2026-10-28T10:00:00Z"));
useRandom(() => 0.999);
// Sending open, as the operator opens it (beta-p1-040): a fresh database has it closed, and a pass's
// reservation would be refused sending_closed.
beforeEach(() => openSending());
const workspace = fixture("wsp_campaigns_approval_safety");
const { app, run, account, enrolledLead, moveStep, stepsOf, enrollmentOf, leadOf } = workspace;
const { dueAt, queue, itemOf, draftReady, approveItem, decide, approved } = workspace;

/**
 * The sender's order (beta-p4-020), reduced: the gate in the claim's run, then linkedin's
 * reserveSend under the step's key, on a pass only.
 */
const sendThroughGate = (accountId: string, stepId: string) =>
  run(async (tx) => {
    const answer = await checkGate(stepId, { at: new Date() });
    if (answer.pass) {
      const { actionType, idempotencyKey } = await tx.stepExecution.findFirstOrThrow({
        where: { id: stepId },
        select: { actionType: true, idempotencyKey: true },
      });
      const reservation = await reserveSend({ accountId, actionType, idempotencyKey });
      assert.ok("reservationId" in reservation, "a passed step is reserved");
    }
    return answer;
  });
const reservations = () => app().senderQuotaReservation.count();
const rowsOf = async (personId: string) =>
  (await stepsOf(personId)).map(({ stepKey, status, skipReason }) => [stepKey, status, skipReason]);
const stepOf = (id: string) => app().stepExecution.findUniqueOrThrow({ where: { id } });
const optOut = (personId: string) =>
  run(() => addOptOut(personId, { source: "system", reason: "reply_opt_out" }));
const FIRST = "Noor, how does your team follow up on warm leads today?";

test("no step reaches scheduled without its approved item; the gate blocks a scheduled step whose item is not approved, skips it with what it saw, and nothing is reserved", async () => {
  const { id: accountId } = await account();
  // A pending item, and a blocked one, decide nothing.
  const pending = await enrolledLead("approval-safety-pending");
  assert.equal(await queue(pending.steps.connect), "opened");
  assert.equal(await decide(pending.steps.connect), "unchanged");
  const blocked = await enrolledLead("approval-safety-blocked");
  assert.equal(await queue(blocked.steps.connect), "opened");
  await run(() => holdForReply(blocked.personId, { at: new Date() }));
  assert.equal((await itemOf(blocked.steps.connect))?.status, "blocked");
  assert.equal(await decide(blocked.steps.connect), "unchanged");
  assert.deepEqual(
    [(await stepOf(pending.steps.connect)).status, (await stepOf(blocked.steps.connect)).status],
    ["awaiting_approval", "held"],
  );

  // Scheduled behind the queue's back: no item, then a pending one.
  const bare = await enrolledLead("approval-safety-bare");
  await moveStep(bare.steps.connect, "scheduled");
  const refused = await sendThroughGate(accountId, bare.steps.connect);
  assert.deepEqual([refused.pass, !refused.pass && refused.reason], [false, "not_approved"]);
  assert.deepEqual(refused.checks.approval, {
    approvalItemId: null,
    status: null,
    contentHash: null,
  });
  await moveStep(pending.steps.connect, "scheduled");
  const early = await sendThroughGate(accountId, pending.steps.connect);
  assert.deepEqual([early.pass, !early.pass && early.reason], [false, "not_approved"]);
  assert.equal(early.checks.approval?.status, "pending");
  assert.equal(await reservations(), 0, "a blocked step takes no reservation");

  // Skipped as an owner's skip of the connection request is followed, the system its actor.
  assert.deepEqual(await rowsOf(bare.personId), [
    ["connect", "skipped", "not_approved"],
    ["message_1", "cancelled", "not_approved"],
    ["follow_up_1", "cancelled", "not_approved"],
    ["follow_up_2", "cancelled", "not_approved"],
  ]);
  assert.deepEqual((await stepOf(bare.steps.connect)).jitChecks, refused.checks);
  const { status, exitReason } = await enrollmentOf(bare.enrollmentId);
  assert.deepEqual([status, exitReason], ["exited", "removed"]);
  assert.equal((await leadOf(bare.personId)).status, "finished");

  // The control: the same harness reserves for a step whose item is approved.
  const clear = await enrolledLead("approval-safety-clear");
  await approved(clear.steps.connect);
  assert.equal((await sendThroughGate(accountId, clear.steps.connect)).pass, true);
  assert.equal(await reservations(), 1);
});

test("a text changed after its approval fails the gate with content_changed: the step skipped with its jit_checks, nothing reserved, the next step due as after a skip", async () => {
  const { id: accountId } = await account();
  const { personId, steps } = await enrolledLead("approval-safety-changed");
  await approved(steps.connect);
  await moveStep(steps.connect, "succeeded");
  await dueAt(steps.message_1, new Date());
  assert.equal(await queue(steps.message_1), "opened");
  await draftReady(steps.message_1, FIRST);
  const itemId = await approveItem(steps.message_1);
  assert.equal(await decide(steps.message_1), "scheduled");
  // A direct write behind messaging's back, after the freeze.
  const { draftId } = await stepOf(steps.message_1);
  assert.ok(draftId);
  const changed = { editedText: `${FIRST} Also, free trial!` };
  await app().messageDraft.update({ where: { id: draftId }, data: changed });

  const answer = await sendThroughGate(accountId, steps.message_1);
  assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, "content_changed"]);
  assert.deepEqual(answer.checks.approval, {
    approvalItemId: itemId,
    status: "approved",
    contentHash: null,
  });
  assert.equal(await reservations(), 0);
  const step = await stepOf(steps.message_1);
  assert.deepEqual([step.status, step.skipReason], ["skipped", "content_changed"]);
  assert.deepEqual(step.jitChecks, answer.checks);
  const next = await stepOf(steps.follow_up_1);
  const expected = nextDueAt("follow_up_1", new Date(answer.checks.at), "UTC");
  assert.deepEqual([next.status, next.dueAt], ["planned", expected]);
  assert.deepEqual(await rowsOf(personId), [
    ["connect", "succeeded", null],
    ["message_1", "skipped", "content_changed"],
    ["follow_up_1", "planned", null],
    ["follow_up_2", "planned", null],
  ]);
});

test("a hold blocks the person's pending items in its transaction, and an approval pressed before it passes nothing: the step's own state is read", async () => {
  const { id: accountId } = await account();
  const waiting = await enrolledLead("approval-safety-held-pending");
  assert.equal(await queue(waiting.steps.connect), "opened");
  const early = await enrolledLead("approval-safety-held-approved");
  await approved(early.steps.connect);
  for (const { personId } of [waiting, early]) {
    await run(() => holdForReply(personId, { at: new Date() }));
  }
  assert.equal((await itemOf(waiting.steps.connect))?.status, "blocked");
  // The approved item stays approved, and approvals' approvedContent still answers for it.
  assert.equal((await itemOf(early.steps.connect))?.status, "approved");
  for (const { steps } of [waiting, early]) {
    const answer = await sendThroughGate(accountId, steps.connect);
    assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, "step_not_ready"]);
  }
  assert.equal(await reservations(), 0);
});

test("the suppression subscriber and the gate's suppression branch block the person's pending items with the steps they cancel", async () => {
  const { id: accountId } = await account();
  const listed = await enrolledLead("approval-safety-subscriber");
  assert.equal(await queue(listed.steps.connect), "opened");
  await optOut(listed.personId);
  await run((tx) => exitSuppressedEnrollments(tx, new Date()));
  assert.equal((await stepOf(listed.steps.connect)).status, "cancelled");
  assert.equal((await itemOf(listed.steps.connect))?.status, "blocked");

  const gated = await enrolledLead("approval-safety-gate");
  await approved(gated.steps.connect);
  // A message waiting in "Up next" beside the scheduled connection request.
  await dueAt(gated.steps.message_1, new Date());
  assert.equal(await queue(gated.steps.message_1), "opened");
  await optOut(gated.personId);
  const answer = await sendThroughGate(accountId, gated.steps.connect);
  assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, "opted_out"]);
  assert.equal((await stepOf(gated.steps.message_1)).status, "cancelled");
  assert.equal((await itemOf(gated.steps.message_1))?.status, "blocked");
  assert.equal(await reservations(), 0);
});

test("a withdrawal passes the gate with no item and no approval check", async () => {
  await account();
  const { steps } = await enrolledLead("approval-safety-withdraw");
  await moveStep(steps.connect, "succeeded");
  // beta-p4-060's withdrawal: the last step rewritten as one.
  const withdrawal = { actionType: "withdraw", stepKey: "withdraw" } as const;
  await app().stepExecution.update({ where: { id: steps.follow_up_2 }, data: withdrawal });
  await moveStep(steps.follow_up_2, "scheduled");
  const answer = await run(() => checkGate(steps.follow_up_2, { at: new Date() }));
  assert.equal(answer.pass, true);
  assert.equal(answer.checks.approval, undefined);
  assert.equal(await itemOf(steps.follow_up_2), null);
});

test("the approval check fails closed: every action needs an approved item but a withdrawal, an action added later included; the queue opens items for connection requests and messages only", () => {
  for (const action of ["invite", "message", "inmail", "follow", ""]) {
    assert.equal(needsApproval(action), true, action);
  }
  assert.equal(needsApproval("withdraw"), false);
  const actions = ["invite", "message", "withdraw", "inmail"];
  assert.deepEqual(
    actions.map((action) => opensItem(action)),
    [true, true, false, false],
  );
});

// The safety cases of the gate and the hold (beta-p2-050; docs/security.md), run by `pnpm -F
// campaigns test:safety` and not by `test`, on the worktree's database in this file's schema: a
// person suppressed after enrollment is skipped with the reason, and a harness that reserves only on
// a pass reserves nothing for them; after holdForReply nothing of the person passes; an inbound
// message on linkedin's outreach row blocks before inbox stores anything; and the hold and the
// caller's write commit together or not at all.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { addOptOut, recordTouch } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { reserveSend } from "@whytide/linkedin";
import {
  createOutreach,
  openSending,
  useClock,
  useLinkedinClient,
  useRandom,
} from "@whytide/linkedin/testing";
import { checkGate } from "../../domain/gate/gate.ts";
import { holdForReply } from "../../domain/hold.ts";
import { linkedinActionType } from "../../domain/steps/actions.ts";
import { fixture } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
// linkedin's reservation reads its own clock: a Wednesday morning, inside the account's hours.
useClock(() => new Date("2026-10-28T10:00:00Z"));
useRandom(() => 0.999);
// Sending open, as the operator opens it (beta-p1-040): a fresh database has it closed.
beforeEach(() => openSending());
const WORKSPACE = "wsp_campaigns_gate_safety";
const { app, run, account, enrolledLead, moveStep, stepsOf, enrollmentOf, leadOf, approved } =
  fixture(WORKSPACE);

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
      const action = linkedinActionType({ id: stepId, actionType });
      const reservation = await reserveSend({ accountId, actionType: action, idempotencyKey });
      assert.ok("reservationId" in reservation, "a passed step is reserved");
    }
    return answer;
  });
const reservations = () => app().senderQuotaReservation.count();
const statuses = async (personId: string) =>
  (await stepsOf(personId)).map(({ stepKey, status, skipReason }) => [stepKey, status, skipReason]);

test("a person suppressed after enrollment is skipped with the reason, and nothing is reserved for them", async () => {
  const { id: accountId } = await account();
  const { personId, enrollmentId, steps } = await enrolledLead("gate-safety-opted-out");
  await moveStep(steps.connect, "scheduled");
  // The opt-out comes after the step was scheduled: the gate reads it now.
  await run(() => addOptOut(personId, { source: "system", reason: "reply_opt_out" }));

  const answer = await sendThroughGate(accountId, steps.connect);
  assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, "opted_out"]);
  assert.equal(await reservations(), 0, "a blocked step takes no reservation");
  assert.deepEqual(await statuses(personId), [
    ["connect", "skipped", "opted_out"],
    ["message_1", "cancelled", "opted_out"],
    ["follow_up_1", "cancelled", "opted_out"],
    ["follow_up_2", "cancelled", "opted_out"],
  ]);
  const { status, exitReason, exitDetail } = await enrollmentOf(enrollmentId);
  assert.deepEqual([status, exitReason, exitDetail], ["exited", "suppressed", "opted_out"]);
  assert.equal((await leadOf(personId)).status, "suppressed");

  // The control: the same harness reserves for a person the gate passes.
  const clear = await enrolledLead("gate-safety-clear");
  await approved(clear.steps.connect);
  assert.equal((await sendThroughGate(accountId, clear.steps.connect)).pass, true);
  assert.equal(await reservations(), 1);
});

test("after holdForReply, no step of the person passes the gate", async () => {
  const { id: accountId } = await account();
  const { personId, steps } = await enrolledLead("gate-safety-held");
  // A step in each status the gate may meet: claimed, scheduled, waiting for approval, planned.
  await moveStep(steps.connect, "executing");
  await moveStep(steps.message_1, "scheduled");
  await moveStep(steps.follow_up_1, "awaiting_approval");
  await run(() => holdForReply(personId, { at: new Date() }));

  for (const [key, id] of Object.entries(steps)) {
    assert.equal((await sendThroughGate(accountId, id)).pass, false, key);
  }
  assert.equal(await reservations(), 0);
  // The claimed step is the sender's: its gate holds it, since the enrollment replied.
  assert.deepEqual(await statuses(personId), [
    ["connect", "held", "enrollment_ended"],
    ["message_1", "held", "replied"],
    ["follow_up_1", "held", "replied"],
    ["follow_up_2", "held", "replied"],
  ]);
});

test("an inbound message on linkedin's outreach row blocks the person before inbox stores it", async () => {
  const { id: accountId } = await account();
  const { personId, enrollmentId, steps } = await enrolledLead("gate-safety-inbound");
  await moveStep(steps.connect, "scheduled");
  // As linkedin's receiver leaves the row, in the run that publishes the message (beta-p0-060);
  // inbox has stored nothing (it has no table before beta-p5-010).
  const outreach = await createOutreach(WORKSPACE, { senderAccountId: accountId, personId });
  const data = { lastInboundAt: new Date() };
  await app().senderOutreach.update({ where: { id: outreach.id }, data });

  const answer = await sendThroughGate(accountId, steps.connect);
  assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, "replied"]);
  assert.equal(await reservations(), 0);
  assert.deepEqual(
    (await statuses(personId)).map(([, status]) => status),
    ["held", "held", "held", "held"],
  );
  assert.equal((await enrollmentOf(enrollmentId)).status, "replied");
  assert.equal((await leadOf(personId)).status, "replied");
});

test("the hold and the caller's write commit together, or not at all", async () => {
  await account();
  const { personId, enrollmentId, steps } = await enrolledLead("gate-safety-together");
  await moveStep(steps.connect, "scheduled");
  const before = await statuses(personId);
  const touchOf = async () =>
    (await app().person.findUniqueOrThrow({ where: { id: personId } })).lastTouchAt;
  const at = new Date();
  // The caller's own write (a contacts command here, standing in for inbox's stored message), the
  // hold, then a failure of the caller's transaction.
  const failure = new Error("the caller's store failed after the hold");
  await assert.rejects(
    run(async () => {
      await recordTouch(personId, at);
      await holdForReply(personId, { at });
      throw failure;
    }),
    failure,
  );
  assert.deepEqual(await statuses(personId), before, "no step held");
  assert.equal((await enrollmentOf(enrollmentId)).status, "active");
  assert.equal((await leadOf(personId)).status, "in_campaign");
  assert.equal(await touchOf(), null, "nor the caller's write");

  await run(async () => {
    await recordTouch(personId, at);
    await holdForReply(personId, { at });
  });
  assert.deepEqual(
    (await statuses(personId)).map(([, status]) => status),
    ["held", "held", "held", "held"],
  );
  assert.equal((await enrollmentOf(enrollmentId)).status, "replied");
  assert.deepEqual(await touchOf(), at);
});

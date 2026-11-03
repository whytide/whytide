// The gate (beta-p2-050; README.md "The gate"), on a schema of the worktree's database, each call in a
// tenant run as `app`: each check with its outcome and its writes, in order (a step not ready, an
// ended enrollment, a suppressed person, a reply since the start, a touch on the sender's day, the
// approval, beta-p3-050), the first failing check deciding, the checks written to jit_checks on a
// block and nothing written on a pass, which answers the approved item and the text's hash. Person
// and company blocks are the worker's test (core/apps/worker/tests/campaigns-suppression.test.ts):
// contacts' index offers this module the opt-out only. The approval's blocks are the safety cases'
// (tests/safety/approval-check.test.ts).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { addOptOut, recordTouch } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { createOutreach, useLinkedinClient } from "@whytide/linkedin/testing";
import { checkGate } from "../domain/gate/gate.ts";
import { fixture } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const WORKSPACE = "wsp_campaigns_gate";
const HOUR_MS = 3_600_000;
const { app, run, account, enrolledLead, moveStep, stepsOf, enrollmentOf, approved } =
  fixture(WORKSPACE);
const gate = (id: string, at = new Date()) => run(() => checkGate(id, { at }));
const stepRow = async (personId: string, key: string) =>
  (await stepsOf(personId)).find(({ stepKey }) => stepKey === key);
/** An inbound message from the person on the account's outreach row, at `at`. */
async function inbound(accountId: string, personId: string, at: Date): Promise<void> {
  const { id } = await createOutreach(WORKSPACE, { senderAccountId: accountId, personId });
  await app().senderOutreach.update({ where: { id }, data: { lastInboundAt: at } });
}
const optOut = (personId: string) =>
  run(() => addOptOut(personId, { source: "system", reason: "reply_opt_out" }));
const ended = {
  replied: { status: "replied" },
  exited: { status: "exited", exitReason: "removed" },
  completed: { status: "completed" },
} as const;

test("a step neither scheduled nor executing is not ready, and nothing is written", async () => {
  await account();
  const { personId, steps } = await enrolledLead("gate-not-ready");
  const at = new Date();
  assert.deepEqual(await gate(steps.connect, at), {
    pass: false,
    reason: "step_not_ready",
    checks: { at: at.toISOString(), step: { status: "planned" } },
  });
  await moveStep(steps.message_1, "succeeded");
  assert.equal((await gate(steps.message_1)).pass, false);
  const unknown = await gate("sx_unknown", at);
  assert.deepEqual(unknown.checks, { at: at.toISOString(), step: { status: null } });
  for (const step of await stepsOf(personId)) {
    assert.deepEqual([step.jitChecks, step.skipReason, step.errorCode], [null, null, null]);
  }
  await assert.rejects(
    run(() => checkGate(steps.connect, { at: new Date(Number.NaN) })),
    /at: no instant/,
  );
});

test("an ended enrollment: the step held for a replied one, cancelled otherwise, an executing one too", async () => {
  await account();
  for (const [kind, claimed] of [
    ["replied", "scheduled"],
    ["exited", "executing"],
    ["completed", "scheduled"],
  ] as const) {
    const { personId, enrollmentId, steps } = await enrolledLead(`gate-ended-${kind}`);
    const data = { ...ended[kind], endedAt: new Date() };
    await app().enrollment.update({ where: { id: enrollmentId }, data });
    await moveStep(steps.connect, claimed);
    const answer = await gate(steps.connect);
    assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, "enrollment_ended"]);
    const step = await stepRow(personId, "connect");
    const status = kind === "replied" ? "held" : "cancelled";
    assert.deepEqual([step?.status, step?.skipReason], [status, "enrollment_ended"], kind);
    assert.deepEqual(step?.jitChecks, answer.checks);
    assert.deepEqual(answer.checks.enrollment, { status: kind });
  }
});

test("a suppressed person: the step skipped with the reason, the pending steps cancelled, an executing one left, the enrollment exited", async () => {
  await account();
  const { personId, enrollmentId, steps } = await enrolledLead("gate-suppressed");
  await moveStep(steps.connect, "scheduled");
  await moveStep(steps.message_1, "awaiting_approval");
  await moveStep(steps.follow_up_1, "executing");
  await optOut(personId);
  const at = new Date();
  const answer = await gate(steps.connect, at);
  assert.deepEqual(answer, {
    pass: false,
    reason: "opted_out",
    checks: {
      at: at.toISOString(),
      step: { status: "scheduled" },
      enrollment: { status: "active" },
      suppression: { suppressed: true, reason: "opted_out" },
    },
  });
  const rows = await stepsOf(personId);
  assert.deepEqual(
    rows.map(({ stepKey, status, skipReason }) => [stepKey, status, skipReason]),
    [
      ["connect", "skipped", "opted_out"],
      ["message_1", "cancelled", "opted_out"],
      ["follow_up_1", "executing", null],
      ["follow_up_2", "cancelled", "opted_out"],
    ],
  );
  assert.deepEqual(rows[0]?.jitChecks, answer.checks);
  assert.deepEqual(await enrollmentOf(enrollmentId), {
    ...{ status: "exited", exitReason: "suppressed", exitDetail: "opted_out", endedAt: at },
  });
});

test("an inbound message since the enrollment began holds the person; one from before it does not", async () => {
  const { id: accountId } = await account();
  const before = await enrolledLead("gate-reply-before");
  const after = await enrolledLead("gate-reply-after");
  await approved(before.steps.connect);
  await moveStep(after.steps.connect, "scheduled");
  const { startedAt } = await app().enrollment.findUniqueOrThrow({
    where: { id: before.enrollmentId },
  });
  assert.ok(startedAt);
  await inbound(accountId, before.personId, new Date(startedAt.getTime() - HOUR_MS));
  const earlier = await gate(before.steps.connect);
  assert.equal(earlier.pass, true, "a message from before the enrollment is no reply to it");

  const repliedAt = new Date();
  await inbound(accountId, after.personId, repliedAt);
  const answer = await gate(after.steps.connect);
  assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, "replied"]);
  const { startedAt: started } = await app().enrollment.findUniqueOrThrow({
    where: { id: after.enrollmentId },
  });
  assert.deepEqual(answer.checks.reply, {
    lastInboundAt: repliedAt.toISOString(),
    startedAt: started?.toISOString(),
  });
  const rows = await stepsOf(after.personId);
  assert.deepEqual(
    rows.map(({ status, skipReason }) => [status, skipReason]),
    Array(4).fill(["held", "replied"]),
  );
  assert.deepEqual(rows[0]?.jitChecks, answer.checks);
  assert.equal((await enrollmentOf(after.enrollmentId)).status, "replied");
});

test("a person touched on the sender's quota day is blocked touched_today, and the step keeps its status", async () => {
  // Kolkata is UTC+05:30: 19:00 UTC on the 28th is already the 29th there.
  await account("Asia/Kolkata");
  const at = new Date("2026-10-29T06:00:00Z");
  const today = await enrolledLead("gate-touched-today");
  const yesterday = await enrolledLead("gate-touched-yesterday");
  await run(async () => {
    await recordTouch(today.personId, new Date("2026-10-28T19:00:00Z"));
    await recordTouch(yesterday.personId, new Date("2026-10-28T18:00:00Z"));
  });
  await moveStep(today.steps.connect, "scheduled");
  await approved(yesterday.steps.connect);

  const answer = await gate(today.steps.connect, at);
  assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, "touched_today"]);
  assert.deepEqual(answer.checks.touch, {
    lastTouchAt: "2026-10-28T19:00:00.000Z",
    quotaDay: "2026-10-29",
  });
  const step = await stepRow(today.personId, "connect");
  assert.deepEqual(
    [step?.status, step?.errorCode, step?.skipReason],
    ["scheduled", "touched_today", null],
  );
  assert.deepEqual(step?.jitChecks, answer.checks);
  assert.equal((await gate(yesterday.steps.connect, at)).pass, true);
});

test("the order: the first check that fails decides", async () => {
  const { id: accountId } = await account();
  const cases = [
    ["enrollment_ended", { ended: true, optedOut: true, replied: true, touched: true }],
    ["opted_out", { ended: false, optedOut: true, replied: true, touched: true }],
    ["replied", { ended: false, optedOut: false, replied: true, touched: true }],
    ["touched_today", { ended: false, optedOut: false, replied: false, touched: true }],
    // Scheduled with no approved item: the approval check comes last.
    ["not_approved", { ended: false, optedOut: false, replied: false, touched: false }],
  ] as const;
  for (const [reason, fails] of cases) {
    const { personId, enrollmentId, steps } = await enrolledLead(`gate-order-${reason}`);
    await moveStep(steps.connect, "scheduled");
    // After the enrollment began, so that the inbound message is a reply to it.
    const at = new Date();
    if (fails.ended) {
      const data = { ...ended.exited, endedAt: at };
      await app().enrollment.update({ where: { id: enrollmentId }, data });
    }
    if (fails.optedOut) await optOut(personId);
    if (fails.replied) await inbound(accountId, personId, at);
    if (fails.touched) await run(() => recordTouch(personId, at));
    const answer = await gate(steps.connect, at);
    assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, reason]);
  }
});

test("a pass answers what each check saw, the approved item and the text's hash among them, and writes nothing", async () => {
  await account();
  const { personId, enrollmentId, steps } = await enrolledLead("gate-pass");
  const approvalItemId = await approved(steps.connect);
  await moveStep(steps.connect, "executing");
  const at = new Date();
  const before = await stepsOf(personId);
  const answer = await gate(steps.connect, at);
  const { startedAt } = await app().enrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
  assert.deepEqual(answer, {
    pass: true,
    checks: {
      at: at.toISOString(),
      step: { status: "executing" },
      enrollment: { status: "active" },
      suppression: { suppressed: false },
      reply: { lastInboundAt: null, startedAt: startedAt?.toISOString() },
      touch: { lastTouchAt: null, quotaDay: at.toISOString().slice(0, 10) },
      // The connection request's note, empty by default.
      approval: { approvalItemId, status: "approved", contentHash: sha256("") },
    },
  });
  assert.deepEqual(await stepsOf(personId), before);
});

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

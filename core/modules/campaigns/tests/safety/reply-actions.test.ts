// The safety cases of the reply actions (gamma-p4-050; README.md "Reply actions"; docs/security.md),
// run by `pnpm -F campaigns test:safety`, on the worktree's database in this file's schema: an
// opt-out label, suggested or not, suppresses the person and cancels their held steps in every
// campaign, in the caller's run; a person suppressed before an out-of-office label is exited, not
// released, and one suppressed during its pause is never resumed; a step whose item was approved
// before the hold is never released on that approval; a resumed step is sent only after a new item,
// its approval and a passing gate, through a harness that reserves on a pass only; and a reply
// during the pause, or after the resume, holds the person again. Each reply is as inbox's store
// leaves it: linkedin's outreach row, then holdForReply at the reply's instant.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { addOptOut, recordLeadStatus, suppressionOf } from "@whytide/contacts";
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
import { newId } from "@whytide/platform";
import { enrollApproved } from "../../domain/enroll/enroll.ts";
import { checkGate } from "../../domain/gate/gate.ts";
import { holdForReply } from "../../domain/hold.ts";
import { applyReplyLabel } from "../../domain/replies/apply.ts";
import type { ReplyActionLabel } from "../../domain/replies/constants.ts";
import { linkedinActionType } from "../../domain/steps/actions.ts";
import { useClock as useCampaignsClock } from "../../testing/index.ts";
import { activities } from "../../workflows/index.ts";
import { APPROVER, fixture } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
// linkedin's reservation reads its own clock: a Wednesday morning, inside the account's hours.
useClock(() => new Date("2026-10-28T10:00:00Z"));
useRandom(() => 0.999);
// Sending open, as the operator opens it (beta-p1-040): a fresh database has it closed.
beforeEach(() => openSending());
const WORKSPACE = "wsp_campaigns_reply_safety";
const f = fixture(WORKSPACE);
const { app, run, account, enrolledLead, moveStep, stepsOf, enrollmentOf, queue } = f;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOW = Date.now();
/** The enrollment began a month ago, and the out-of-office reply came ten days ago. */
const STARTED = new Date(NOW - 30 * DAY_MS);
const REPLIED = new Date(NOW - 10 * DAY_MS);
const THREAD = "thr_reply_safety";

/** The sender's order (beta-p4-020), reduced: the gate, then linkedin's reserveSend on a pass only. */
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

/** No step of the person passes the gate, and nothing is reserved. */
async function nothingPasses(accountId: string, personId: string): Promise<void> {
  for (const { id, stepKey } of await stepsOf(personId)) {
    assert.equal((await sendThroughGate(accountId, id)).pass, false, stepKey);
  }
  assert.equal(await reservations(), 0);
}

/** The label applied in a run of its own, as inbox's classification will (gamma-p4-040). */
const label = (
  personId: string,
  replyLabel: ReplyActionLabel,
  options: { suggested?: boolean; repliedAt?: Date } = {},
) =>
  run(() =>
    applyReplyLabel(personId, {
      label: replyLabel,
      suggested: options.suggested ?? false,
      returnDate: null,
      repliedAt: options.repliedAt ?? REPLIED,
      threadId: THREAD,
      ownerUserId: APPROVER,
    }),
  );

/** The queue run's start (campaigns_due_steps) at `at`, on the module's clock. */
async function queueRunStart(at: Date): Promise<string[]> {
  useCampaignsClock(() => at);
  try {
    const tenant = <T>(fn: (tx: unknown) => Promise<T>) => run(fn);
    const context = { workspaceId: WORKSPACE, workflowId: "wf_queue", attempt: 1, tenant };
    const { stepIds } = await activities.campaigns_due_steps.run(
      { workspaceId: WORKSPACE },
      context,
    );
    return stepIds;
  } finally {
    useCampaignsClock(undefined);
  }
}

/** A reply on linkedin's outreach row at `at`, then inbox's hold, in one run as its store has it. */
async function reply(outreachId: string, personId: string, at: Date): Promise<void> {
  await app().senderOutreach.update({ where: { id: outreachId }, data: { lastInboundAt: at } });
  await run(() => holdForReply(personId, { at }));
}

/**
 * A lead whose connection request and first message went out, the first follow-up due and its item
 * opened, then the out-of-office reply at REPLIED: its follow-ups held, that item blocked.
 */
async function heldLead(accountId: string, slug: string) {
  const lead = await enrolledLead(slug);
  const { personId, enrollmentId, steps } = lead;
  await app().enrollment.update({ where: { id: enrollmentId }, data: { startedAt: STARTED } });
  await moveStep(steps.connect, "succeeded");
  await moveStep(steps.message_1, "succeeded");
  await f.dueAt(steps.follow_up_1, new Date(REPLIED.getTime() - HOUR_MS));
  assert.equal(await queue(steps.follow_up_1), "opened");
  const outreach = await createOutreach(WORKSPACE, { senderAccountId: accountId, personId });
  await reply(outreach.id, personId, REPLIED);
  return { ...lead, outreachId: outreach.id };
}

for (const suggested of [true, false]) {
  test(`an opt_out label ${suggested ? "only suggested" : "confirmed"} suppresses the person and cancels their held steps in every campaign, in the caller's run`, async () => {
    const { id: accountId } = await account();
    const first = await heldLead(accountId, `reply-safety-opt-out-${suggested}`);
    const { personId } = first;
    // A second campaign's enrollment of the same person, held by a later reply.
    await run(() =>
      recordLeadStatus(personId, "approved", { actor: { type: "user", id: APPROVER } }),
    );
    const again = { sourceEventId: newId("obx"), personId, approvedBy: APPROVER };
    assert.equal(await run((tx) => enrollApproved(tx, again)), "enrolled");
    await reply(first.outreachId, personId, new Date(NOW - DAY_MS));
    const held = (await stepsOf(personId)).filter(({ status }) => status === "held");
    assert.equal(new Set(held.map(({ id }) => id)).size, 6, "two follow-ups, then four steps");
    const before = await statuses(personId);

    // The caller's run fails after the label: nothing of it stays.
    const failure = new Error("the caller's run failed after the label");
    await assert.rejects(
      run(async () => {
        await applyReplyLabel(personId, {
          ...{ label: "opt_out", suggested, returnDate: null, repliedAt: REPLIED },
          ...{ threadId: THREAD, ownerUserId: APPROVER },
        });
        throw failure;
      }),
      failure,
    );
    assert.deepEqual(await statuses(personId), before);
    assert.equal(
      (await run(() => suppressionOf(personId, { newEnrollment: false }))).suppressed,
      false,
    );

    const taken = await label(personId, "opt_out", { suggested });
    assert.deepEqual(taken.actions, ["label_recorded", "opted_out", "steps_cancelled"]);
    assert.equal(taken.enrollmentIds.length, 2, "both enrollments");
    const suppression = await run(() => suppressionOf(personId, { newEnrollment: false }));
    assert.deepEqual(suppression, { suppressed: true, reason: "opted_out" });
    for (const { id } of held) {
      const step = await app().stepExecution.findUniqueOrThrow({ where: { id } });
      assert.deepEqual([step.status, step.skipReason], ["cancelled", "opted_out"]);
    }
    await nothingPasses(accountId, personId);
  });
}

test("a person suppressed before an out-of-office label is exited, not released", async () => {
  const { id: accountId } = await account();
  const { personId, enrollmentId, steps } = await heldLead(accountId, "reply-safety-before");
  await run(() => addOptOut(personId, { source: "manual", createdBy: APPROVER }));

  const taken = await label(personId, "out_of_office");
  assert.deepEqual(taken.actions, ["label_recorded", "exited_suppressed"]);
  const enrollment = await app().enrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
  assert.deepEqual(
    [enrollment.status, enrollment.exitReason, enrollment.exitDetail, enrollment.pausedReason],
    ["exited", "suppressed", "opted_out", null],
  );
  assert.equal(enrollment.resumedAt, null, "never resumed");
  for (const key of ["follow_up_1", "follow_up_2"] as const) {
    const step = await app().stepExecution.findUniqueOrThrow({ where: { id: steps[key] } });
    assert.deepEqual([step.status, step.skipReason], ["cancelled", "opted_out"], key);
  }
  assert.deepEqual(await queueRunStart(new Date(NOW)), []);
  await nothingPasses(accountId, personId);
});

test("a person suppressed during an out-of-office pause is never resumed, though the suppression's delivery has not run", async () => {
  const { id: accountId } = await account();
  const { personId, enrollmentId } = await heldLead(accountId, "reply-safety-during");
  assert.deepEqual((await label(personId, "out_of_office")).actions, [
    "label_recorded",
    "released",
    "paused",
  ]);
  // contacts.suppression_added is only in the outbox: its subscriber has not exited anything.
  await run(() => addOptOut(personId, { source: "manual", createdBy: APPROVER }));
  assert.equal((await enrollmentOf(enrollmentId)).status, "paused");

  // The queue run after the pause's end (seven days after the reply, three days ago).
  assert.deepEqual(await queueRunStart(new Date(NOW)), []);
  // Exited from its pause: the queue run's resume never saw it live.
  const { status, exitReason, exitDetail } = await enrollmentOf(enrollmentId);
  assert.deepEqual([status, exitReason, exitDetail], ["exited", "suppressed", "opted_out"]);
  assert.deepEqual((await statuses(personId)).slice(2), [
    ["follow_up_1", "cancelled", "opted_out"],
    ["follow_up_2", "cancelled", "opted_out"],
  ]);
  await nothingPasses(accountId, personId);
});

test("a held step whose item was approved before the reply is never released on that approval", async () => {
  const { id: accountId } = await account();
  const lead = await enrolledLead("reply-safety-approved");
  const { personId, enrollmentId, steps } = lead;
  await app().enrollment.update({ where: { id: enrollmentId }, data: { startedAt: STARTED } });
  await moveStep(steps.connect, "succeeded");
  await moveStep(steps.message_1, "succeeded");
  await f.dueAt(steps.follow_up_1, new Date(REPLIED.getTime() - HOUR_MS));
  assert.equal(await queue(steps.follow_up_1), "opened");
  await f.draftReady(steps.follow_up_1, "Any thoughts?");
  await f.approveItem(steps.follow_up_1);
  assert.equal(await f.decide(steps.follow_up_1), "scheduled");
  const outreach = await createOutreach(WORKSPACE, { senderAccountId: accountId, personId });
  await reply(outreach.id, personId, REPLIED);

  const taken = await label(personId, "out_of_office");
  assert.deepEqual(taken.actions, ["label_recorded", "kept_held"]);
  assert.equal((await enrollmentOf(enrollmentId)).status, "replied");
  assert.deepEqual(await queueRunStart(new Date(NOW)), []);
  await nothingPasses(accountId, personId);
});

test("a resumed step is sent only after a new item, its approval and a passing gate; nothing is reserved before", async () => {
  const { id: accountId } = await account();
  const { personId, enrollmentId, steps } = await heldLead(accountId, "reply-safety-resumed");
  const blocked = await f.itemOf(steps.follow_up_1);
  assert.equal(blocked?.status, "blocked", "the hold blocked the item opened before the reply");

  await label(personId, "out_of_office");
  assert.equal((await sendThroughGate(accountId, steps.follow_up_1)).pass, false, "paused");
  assert.deepEqual(await queueRunStart(new Date(NOW)), [steps.follow_up_1]);
  assert.equal((await enrollmentOf(enrollmentId)).status, "active");
  assert.equal(await queue(steps.follow_up_1), "opened");
  const item = await f.itemOf(steps.follow_up_1);
  assert.ok(item !== null && item.id !== blocked?.id, "a new item");
  assert.equal(item.status, "pending");
  assert.equal((await sendThroughGate(accountId, steps.follow_up_1)).pass, false, "not approved");
  assert.equal(await reservations(), 0);

  await f.draftReady(steps.follow_up_1, "Welcome back. Any thoughts?");
  await f.approveItem(steps.follow_up_1);
  assert.equal(await f.decide(steps.follow_up_1), "scheduled");
  // The out-of-office reply itself, at the resume's instant, holds it no more.
  const answer = await sendThroughGate(accountId, steps.follow_up_1);
  assert.equal(answer.pass, true);
  assert.deepEqual(answer.checks.reply, {
    lastInboundAt: REPLIED.toISOString(),
    startedAt: STARTED.toISOString(),
    resumedAt: REPLIED.toISOString(),
  });
  assert.equal(answer.checks.approval?.approvalItemId, item.id);
  assert.equal(await reservations(), 1);
});

test("a reply during the out-of-office pause holds the person again, and none of their steps passes", async () => {
  const { id: accountId } = await account();
  const { personId, enrollmentId, outreachId } = await heldLead(accountId, "reply-safety-pause");
  await label(personId, "out_of_office");
  assert.equal((await enrollmentOf(enrollmentId)).status, "paused");

  await reply(outreachId, personId, new Date(REPLIED.getTime() + 2 * DAY_MS));
  const enrollment = await app().enrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
  assert.deepEqual([enrollment.status, enrollment.pausedReason], ["replied", null]);
  assert.deepEqual(
    (await statuses(personId)).map(([key, status]) => [key, status]),
    [
      ["connect", "succeeded"],
      ["message_1", "succeeded"],
      ["follow_up_1", "held"],
      ["follow_up_2", "held"],
    ],
  );
  assert.deepEqual(await queueRunStart(new Date(NOW)), []);
  await nothingPasses(accountId, personId);
});

test("a reply after the resume that inbox has not stored yet holds the step at the gate", async () => {
  const { id: accountId } = await account();
  const { personId, enrollmentId, steps, outreachId } = await heldLead(
    accountId,
    "reply-safety-after",
  );
  await label(personId, "out_of_office");
  await queueRunStart(new Date(NOW));
  assert.equal(await queue(steps.follow_up_1), "opened");
  await f.draftReady(steps.follow_up_1, "Welcome back.");
  await f.approveItem(steps.follow_up_1);
  assert.equal(await f.decide(steps.follow_up_1), "scheduled");
  // As linkedin's receiver leaves the row, before inbox's store runs its hold.
  const data = { lastInboundAt: new Date(NOW - HOUR_MS) };
  await app().senderOutreach.update({ where: { id: outreachId }, data });

  const answer = await sendThroughGate(accountId, steps.follow_up_1);
  assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, "replied"]);
  assert.equal(await reservations(), 0);
  assert.equal((await enrollmentOf(enrollmentId)).status, "replied");
  await nothingPasses(accountId, personId);
});

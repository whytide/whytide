// The queue and the decision (beta-p3-050; README.md "The queue", "The decision"), on a schema of the
// worktree's database, each call in a tenant run as `app`: the due steps and their window; queueStep's
// cases (one item as the sender account's owner, with the drafts the person was already sent; a
// step passed over; no sender); the decision subscriber's cases (approved, a message skipped, also
// once linkedin no longer holds the account, the last step skipped, the connection request skipped,
// and what changes nothing, a decision without who made it included); nextDueAt across a weekend and
// a time zone; a first message left with no due time given one (beta-p4-040). approvals' commands
// are its routes' only: the fixtures leave its rows as approve and skip do, and the worker's test
// runs the commands (campaigns-queue.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import type { StepDecision } from "@whytide/approvals";
import { addOptOut } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { applyDecision, storedDecision } from "../domain/decisions.ts";
import { exitSuppressedEnrollments } from "../domain/gate/suppressed.ts";
import { holdForReply } from "../domain/hold.ts";
import { dueStepIds } from "../domain/queue/due.ts";
import { recoverFirstMessages } from "../domain/queue/recover.ts";
import { nextDueAt } from "../domain/template/due.ts";
import { APPROVER, fixture } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const HOUR_MS = 3_600_000;
const workspace = fixture("wsp_campaigns_queue");
const { app, run, account, enrolledLead, moveStep, stepsOf, enrollmentOf, leadOf } = workspace;
const { dueAt, queue, itemOf, draftReady, approveItem, skipItem, decide, approved } = workspace;
const due = (at = new Date()) => run(() => dueStepIds(at));
const stepOf = (id: string) => app().stepExecution.findUniqueOrThrow({ where: { id } });
const rowsOf = async (personId: string) =>
  (await stepsOf(personId)).map(({ stepKey, status, skipReason }) => [stepKey, status, skipReason]);
/** The person's messaging.draft_requested payloads, oldest first: as whom, from which drafts. */
const requests = async (personId: string) =>
  (
    await app().outboxEntry.findMany({
      where: { eventName: "messaging.draft_requested" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  )
    .map(
      ({ payload }) => payload as { personId: string; userId: string; earlierDraftIds: string[] },
    )
    .filter((payload) => payload.personId === personId)
    .map(({ userId, earlierDraftIds }) => ({ userId, earlierDraftIds }));
const draftOf = async (stepId: string) =>
  (await app().messageDraft.findFirstOrThrow({ where: { stepExecutionId: stepId } })).id;
const FIRST = "Noor, how does your team follow up on warm leads today?";

test("a due connection request gets one item with its empty note and awaits approval with it; a second turn opens nothing new", async () => {
  const { id: senderAccountId } = await account();
  const { personId, steps } = await enrolledLead("queue-connect");
  assert.deepEqual(await due(), [steps.connect]);
  assert.equal(await queue(steps.connect), "opened");

  const step = await stepOf(steps.connect);
  const item = await itemOf(steps.connect);
  assert.ok(item);
  assert.deepEqual(
    [item.status, item.actionType, item.stepKey, item.senderAccountId, item.scheduledFor],
    ["pending", "invite", "connect", senderAccountId, step.dueAt],
  );
  assert.deepEqual(
    [step.status, step.approvalItemId, step.draftId],
    ["awaiting_approval", item.id, null],
  );
  // The note is messaging's, empty and ready at once: no model call, so no request.
  const draft = await app().messageDraft.findFirstOrThrow({ where: { personId } });
  assert.deepEqual(
    [draft.id, draft.kind, draft.channel, draft.status, draft.text],
    [item.draftId, "outbound_step", "linkedin_note", "ready", ""],
  );
  assert.deepEqual(await requests(personId), []);

  assert.equal(await queue(steps.connect), "passed_over");
  assert.equal(await app().approvalItem.count({ where: { personId } }), 1);
  assert.equal(await app().messageDraft.count({ where: { personId } }), 1);
  assert.deepEqual(await due(), []);
});

test("the due steps: planned connection requests and messages due within 24 hours, oldest first, of active enrollments; one due in 25 hours waits, and a withdrawal never gets an item", async () => {
  await account();
  const now = new Date();
  const soon = await enrolledLead("queue-due-soon");
  const later = await enrolledLead("queue-due-later");
  const ended = await enrolledLead("queue-due-ended");
  await dueAt(soon.steps.connect, new Date(now.getTime() + 24 * HOUR_MS));
  await dueAt(soon.steps.message_1, new Date(now.getTime() - HOUR_MS));
  await dueAt(later.steps.connect, new Date(now.getTime() + 25 * HOUR_MS));
  const exited = { status: "exited", exitReason: "removed", endedAt: now } as const;
  await app().enrollment.update({ where: { id: ended.enrollmentId }, data: exited });
  // beta-p4-060's withdrawal, due now: the last step rewritten as one.
  const withdrawal = { actionType: "withdraw", stepKey: "withdraw", dueAt: now } as const;
  await app().stepExecution.update({ where: { id: soon.steps.follow_up_2 }, data: withdrawal });

  assert.deepEqual(await due(now), [soon.steps.message_1, soon.steps.connect]);
  assert.deepEqual(await due(new Date(now.getTime() + HOUR_MS)), [
    soon.steps.message_1,
    soon.steps.connect,
    later.steps.connect,
  ]);
  assert.equal(await queue(soon.steps.follow_up_2), "passed_over");
  assert.equal(await itemOf(soon.steps.follow_up_2), null);
  await assert.rejects(due(new Date(Number.NaN)), /at: no instant/);
});

test("a message's item asks for its draft as the sender account's owner, from the drafts the person was already sent, oldest first", async () => {
  await account();
  const { personId, steps } = await enrolledLead("queue-follow-up");
  await approved(steps.connect);
  // As the sender (beta-p4-020) and the acceptance (beta-p4-050) will leave them.
  await moveStep(steps.connect, "succeeded");
  await dueAt(steps.message_1, new Date());
  assert.equal(await queue(steps.message_1), "opened");
  await draftReady(steps.message_1, FIRST);
  await approveItem(steps.message_1);
  assert.equal(await decide(steps.message_1), "scheduled");
  await moveStep(steps.message_1, "succeeded");
  await dueAt(steps.follow_up_1, new Date());
  assert.equal(await queue(steps.follow_up_1), "opened");

  const [connect, message1] = [await draftOf(steps.connect), await draftOf(steps.message_1)];
  assert.deepEqual(await requests(personId), [
    { userId: APPROVER, earlierDraftIds: [connect] },
    { userId: APPROVER, earlierDraftIds: [connect, message1] },
  ]);
});

test("passed over: a suppressed person's step, with no item and no draft; a step no longer planned; an ended enrollment's; no_sender for an account linkedin no longer holds, the step left planned", async () => {
  await account();
  const suppressed = await enrolledLead("queue-suppressed");
  const reason = { source: "system", reason: "reply_opt_out" } as const;
  await run(() => addOptOut(suppressed.personId, reason));
  assert.equal(await queue(suppressed.steps.connect), "passed_over");
  assert.equal(await app().messageDraft.count({ where: { personId: suppressed.personId } }), 0);

  const sent = await enrolledLead("queue-sent");
  await moveStep(sent.steps.connect, "succeeded");
  assert.equal(await queue(sent.steps.connect), "passed_over");

  const replied = await enrolledLead("queue-replied");
  const data = { status: "replied", endedAt: new Date() } as const;
  await app().enrollment.update({ where: { id: replied.enrollmentId }, data });
  assert.equal(await queue(replied.steps.connect), "passed_over");

  const gone = await enrolledLead("queue-no-sender");
  const elsewhere = { senderAccountId: "sac_gone" };
  await app().stepExecution.update({ where: { id: gone.steps.connect }, data: elsewhere });
  assert.equal(await queue(gone.steps.connect), "no_sender");
  assert.equal((await stepOf(gone.steps.connect)).status, "planned");

  for (const { steps } of [suppressed, sent, replied, gone]) {
    assert.equal(await itemOf(steps.connect), null);
  }
  assert.equal(await queue("sx_unknown"), "passed_over");
  assert.equal(await queue(""), "passed_over");
});

test("approved: the step scheduled with the item's draft; the same event again, a pending item and another item's event change nothing", async () => {
  await account();
  const { steps } = await enrolledLead("decide-approved");
  assert.equal(await queue(steps.connect), "opened");
  assert.equal(await decide(steps.connect), "unchanged", "a pending item");
  const other = { approvalItemId: "apv_other", stepExecutionId: steps.connect };
  assert.equal(await run((tx) => applyDecision(tx, other)), "unchanged");
  assert.equal((await stepOf(steps.connect)).status, "awaiting_approval");

  const itemId = await approveItem(steps.connect);
  assert.equal(await decide(steps.connect), "scheduled");
  const step = await stepOf(steps.connect);
  const draftId = (await itemOf(steps.connect))?.draftId;
  assert.deepEqual(
    [step.status, step.approvalItemId, step.draftId],
    ["scheduled", itemId, draftId],
  );
  assert.equal(await decide(steps.connect), "unchanged", "the same event again");
  assert.deepEqual(await stepOf(steps.connect), step);
});

test("a message skipped: the step skipped_by_owner, and the next step due its business days after the skip, Monday to Friday in the sender's zone", async () => {
  await account("Asia/Kolkata");
  const { personId, enrollmentId, steps } = await enrolledLead("decide-skip-message");
  await moveStep(steps.connect, "succeeded");
  await dueAt(steps.message_1, new Date());
  assert.equal(await queue(steps.message_1), "opened");
  // Friday 17:30 in Kolkata (12:00 UTC): three business days later is Wednesday 17:30 there.
  await skipItem(steps.message_1, new Date("2026-10-30T12:00:00Z"));
  assert.equal(await decide(steps.message_1), "skipped");
  assert.deepEqual(await rowsOf(personId), [
    ["connect", "succeeded", null],
    ["message_1", "skipped", "skipped_by_owner"],
    ["follow_up_1", "planned", null],
    ["follow_up_2", "planned", null],
  ]);
  const followUp = await stepOf(steps.follow_up_1);
  assert.equal(followUp.dueAt?.toISOString(), "2026-11-04T12:00:00.000Z");
  assert.equal((await enrollmentOf(enrollmentId)).status, "active");
  assert.equal((await leadOf(personId)).status, "in_campaign");
  assert.equal(await decide(steps.message_1), "unchanged");
});

test("a message skipped once linkedin no longer holds its account: the skip stands, the next step gets no due time, and the delivery does not fail", async () => {
  await account();
  const { personId, steps } = await enrolledLead("decide-skip-no-account");
  await moveStep(steps.connect, "succeeded");
  await dueAt(steps.message_1, new Date());
  assert.equal(await queue(steps.message_1), "opened");
  await skipItem(steps.message_1, new Date());
  // The account gone between the press and the delivery, as in the queue's no_sender case.
  const gone = { senderAccountId: "sac_gone" };
  await app().stepExecution.update({ where: { id: steps.message_1 }, data: gone });
  assert.equal(await decide(steps.message_1), "skipped");
  assert.deepEqual(await rowsOf(personId), [
    ["connect", "succeeded", null],
    ["message_1", "skipped", "skipped_by_owner"],
    ["follow_up_1", "planned", null],
    ["follow_up_2", "planned", null],
  ]);
  assert.equal((await stepOf(steps.follow_up_1)).dueAt, null);
  assert.equal(await decide(steps.message_1), "unchanged", "the same event again");
});

test("the last step skipped completes the enrollment and finishes the lead, the owner its actor", async () => {
  await account();
  const { personId, enrollmentId, steps } = await enrolledLead("decide-skip-last");
  for (const id of [steps.connect, steps.message_1, steps.follow_up_1]) {
    await moveStep(id, "succeeded");
  }
  await dueAt(steps.follow_up_2, new Date());
  assert.equal(await queue(steps.follow_up_2), "opened");
  const at = new Date();
  await skipItem(steps.follow_up_2, at);
  assert.equal(await decide(steps.follow_up_2), "skipped");
  assert.deepEqual(await enrollmentOf(enrollmentId), {
    ...{ status: "completed", exitReason: null, exitDetail: null, endedAt: at },
  });
  assert.equal((await leadOf(personId)).status, "finished");
  const change = await app().leadStatusChange.findFirstOrThrow({
    where: { personId, toStatus: "finished" },
  });
  assert.deepEqual(
    [change.reason, change.templateId, change.actorType, change.actorId],
    [null, "linkedin_default", "user", APPROVER],
  );
});

test("the connection request skipped ends the enrollment: the other steps cancelled, the enrollment exited (removed), the lead finished", async () => {
  await account();
  const { personId, enrollmentId, steps } = await enrolledLead("decide-skip-connect");
  assert.equal(await queue(steps.connect), "opened");
  const at = new Date();
  await skipItem(steps.connect, at);
  assert.equal(await decide(steps.connect), "skipped");
  assert.deepEqual(await rowsOf(personId), [
    ["connect", "skipped", "skipped_by_owner"],
    ["message_1", "cancelled", "skipped_by_owner"],
    ["follow_up_1", "cancelled", "skipped_by_owner"],
    ["follow_up_2", "cancelled", "skipped_by_owner"],
  ]);
  assert.deepEqual(await enrollmentOf(enrollmentId), {
    ...{ status: "exited", exitReason: "removed", exitDetail: null, endedAt: at },
  });
  const lead = await leadOf(personId);
  assert.deepEqual([lead.status, lead.changes.at(-1)], ["finished", "in_campaign>finished"]);
  const change = await app().leadStatusChange.findFirstOrThrow({
    where: { personId, toStatus: "finished" },
  });
  assert.deepEqual(
    [change.reason, change.actorType, change.actorId],
    ["removed", "user", APPROVER],
  );
  assert.equal(await decide(steps.connect), "unchanged");
  assert.equal((await leadOf(personId)).changes.length, lead.changes.length);
});

test("a decision delivered after a hold or a cancel changes nothing", async () => {
  await account();
  const held = await enrolledLead("decide-after-hold");
  const cancelled = await enrolledLead("decide-after-cancel");
  for (const { steps } of [held, cancelled]) {
    assert.equal(await queue(steps.connect), "opened");
    // Pressed before the stop, delivered after it.
    await approveItem(steps.connect);
  }
  await run(() => holdForReply(held.personId, { at: new Date() }));
  const reason = { source: "system", reason: "reply_opt_out" } as const;
  await run(() => addOptOut(cancelled.personId, reason));
  await run((tx) => exitSuppressedEnrollments(tx, new Date()));

  assert.equal(await decide(held.steps.connect), "unchanged");
  assert.equal(await decide(cancelled.steps.connect), "unchanged");
  assert.deepEqual((await rowsOf(held.personId))[0], ["connect", "held", "replied"]);
  assert.deepEqual((await rowsOf(cancelled.personId))[0], ["connect", "cancelled", "opted_out"]);
});

test("a stored decision counts only for the event's item, approved or skipped, with who decided and when, or approved by the mode, which names no person", () => {
  const at = new Date("2026-10-29T10:00:00Z");
  const stored = {
    ...{ stepExecutionId: "sx_1", approvalItemId: "apv_1", draftId: "drf_1" },
    approvalBy: "person",
  } as const;
  const decided = { ...stored, decidedBy: APPROVER, decidedAt: at, decisionOrigin: "app" } as const;
  const approvedItem: StepDecision = { ...decided, status: "approved" };
  assert.deepEqual(storedDecision(approvedItem, "apv_1"), { status: "approved", draftId: "drf_1" });
  const skippedItem: StepDecision = { ...decided, status: "skipped" };
  assert.deepEqual(storedDecision(skippedItem, "apv_1"), { status: "skipped", by: APPROVER, at });
  // gamma-p4-070: the mode's approval schedules its step; the gate decides whether it may go.
  const byMode = { approvalBy: "mode", decidedBy: null, decisionOrigin: "approval_mode" } as const;
  const modeItem: StepDecision = { ...decided, ...byMode, status: "approved" };
  assert.deepEqual(storedDecision(modeItem, "apv_1"), { status: "approved", draftId: "drf_1" });
  const undecided = { ...stored, decidedBy: null, decidedAt: null, decisionOrigin: null } as const;
  const none: (StepDecision | undefined)[] = [
    undefined,
    { ...decided, status: "approved", approvalItemId: "apv_2" },
    { ...decided, status: "approved", decidedBy: null },
    { ...decided, status: "approved", decidedAt: null },
    { ...decided, status: "skipped", decidedBy: null },
    { ...decided, status: "skipped", decidedAt: null },
    { ...decided, ...byMode, status: "approved", decidedAt: null },
    { ...decided, ...byMode, status: "approved", approvalItemId: "apv_2" },
    { ...undecided, status: "pending" },
    { ...undecided, status: "blocked" },
  ];
  for (const latest of none) {
    assert.equal(storedDecision(latest, "apv_1"), null, JSON.stringify(latest));
  }
});

test("nextDueAt: a follow-up's business days from the instant given, Monday to Friday in the zone given, across a weekend; none for a step not counted from the one before", () => {
  const friday = new Date("2026-10-30T17:00:00Z");
  assert.equal(nextDueAt("follow_up_1", friday, "UTC")?.toISOString(), "2026-11-04T17:00:00.000Z");
  // Friday 23:00 UTC is already Saturday 04:30 in Kolkata: five business days from the Saturday
  // end on Friday 04:30 there, a day before the same count in UTC.
  const late = new Date("2026-10-30T23:00:00Z");
  assert.equal(
    nextDueAt("follow_up_2", late, "Asia/Kolkata")?.toISOString(),
    "2026-11-05T23:00:00.000Z",
  );
  assert.equal(nextDueAt("follow_up_2", late, "UTC")?.toISOString(), "2026-11-06T23:00:00.000Z");
  for (const key of ["connect", "message_1", "withdraw"]) {
    assert.equal(nextDueAt(key, friday, "UTC"), null, key);
  }
});

test("a first message its acceptance left with no due time gets one at a queue run once linkedin holds its account again: none before, and none twice", async () => {
  const other = fixture("wsp_campaigns_first_message");
  await other.account();
  const { steps } = await other.enrolledLead("recover-first-message");
  const rows = other.app().stepExecution;
  await rows.update({ where: { id: steps.connect }, data: { acceptedAt: new Date() } });
  await other.moveStep(steps.connect, "succeeded");
  const { senderAccountId, status, dueAt } = await stepOf(steps.message_1);
  assert.deepEqual([status, dueAt], ["planned", null]);
  const recover = (at: Date) => other.run(() => recoverFirstMessages(at));
  const gone = { senderAccountId: "sac_gone" };
  await rows.update({ where: { id: steps.message_1 }, data: gone });
  assert.equal(await recover(new Date()), 0);
  await rows.update({ where: { id: steps.message_1 }, data: { senderAccountId } });
  const at = new Date();
  assert.equal(await recover(at), 1);
  const due = (await stepOf(steps.message_1)).dueAt;
  assert.ok(due !== null && due > at, `due ${due?.toISOString()}`);
  assert.equal(await recover(new Date()), 0);
});

test("a first message after a connection request skipped as already connected, left with no due time, gets one at a queue run too; none while the request is neither accepted nor skipped so", async () => {
  const other = fixture("wsp_campaigns_first_message_connected");
  await other.account();
  const { steps } = await other.enrolledLead("recover-connected");
  const recover = (at: Date) => other.run(() => recoverFirstMessages(at));
  assert.equal(await recover(new Date()), 0);
  const skipped = { status: "skipped", skipReason: "already_connected" } as const;
  await other.app().stepExecution.update({ where: { id: steps.connect }, data: skipped });
  const at = new Date();
  assert.equal(await recover(at), 1);
  const due = (await stepOf(steps.message_1)).dueAt;
  assert.ok(due !== null && due > at, `due ${due?.toISOString()}`);
});

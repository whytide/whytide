// The reply actions (gamma-p4-050; README.md "Reply actions"), on the worktree's database in this
// file's schema, each call in a tenant run as `app`: each label, suggested and not; the out-of-office
// pause's end on business days in the sender's zone, and the first queue run after it; the reminder
// published once by the queue run; a later label undoing the earlier one first, an out-of-office
// pause included; a repeat changing nothing; and the cool-down at enrollment, at the times given.
// The safety cases are tests/safety/reply-actions.test.ts; the notice's mail is the worker's
// (core/apps/worker/tests/campaigns-reply-notice.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { recordLeadStatus } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { createOutreach, useLinkedinClient } from "@whytide/linkedin/testing";
import { newId } from "@whytide/platform";
import { enrollApproved } from "../domain/enroll/enroll.ts";
import { holdForReply } from "../domain/hold.ts";
import { applyReplyLabel, type ReplyLabelInput } from "../domain/replies/apply.ts";
import type { ReplyActionLabel } from "../domain/replies/constants.ts";
import { outOfOfficeUntil } from "../domain/replies/pause-end.ts";
import { useClock } from "../testing/index.ts";
import { activities } from "../workflows/index.ts";
import { APPROVER, fixture } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const WORKSPACE = "wsp_campaigns_replies";
const f = fixture(WORKSPACE);
const { app, run, account, enrolledLead, moveStep, stepsOf, queue } = f;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A Thursday morning; the sender account is in Berlin, an hour ahead of UTC in November. */
const REPLIED = new Date("2026-11-05T10:00:00Z");
const ZONE = "Europe/Berlin";
const THREAD = "thr_replies";
const NOTICE = "campaigns.reply_notice_due";

const label = (
  personId: string,
  replyLabel: ReplyActionLabel,
  options: Partial<ReplyLabelInput> = {},
) =>
  run(() =>
    applyReplyLabel(personId, {
      ...{ label: replyLabel, suggested: false, returnDate: null, repliedAt: REPLIED },
      ...{ threadId: THREAD, ownerUserId: APPROVER, ...options },
    }),
  );

/** The queue run's start at `at` (campaigns_due_steps), on the module's clock: the steps it lists. */
async function queueRunStart(at: Date): Promise<string[]> {
  useClock(() => at);
  try {
    const tenant = <T>(fn: (tx: unknown) => Promise<T>) => run(fn);
    const context = { workspaceId: WORKSPACE, workflowId: "wf_queue", attempt: 1, tenant };
    const { stepIds } = await activities.campaigns_due_steps.run(
      { workspaceId: WORKSPACE },
      context,
    );
    return stepIds;
  } finally {
    useClock(undefined);
  }
}

const enrollmentRow = (id: string) => app().enrollment.findUniqueOrThrow({ where: { id } });
const notices = async () =>
  (
    await app().outboxEntry.findMany({
      where: { eventName: NOTICE },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).map(({ payload }) => payload);
const statuses = async (personId: string) =>
  (await stepsOf(personId)).map(({ stepKey, status, skipReason }) => [stepKey, status, skipReason]);

/**
 * A lead whose connection request and first message went out, the first follow-up due a day before
 * the reply, then held by the reply at REPLIED, as inbox's store leaves it.
 */
async function heldLead(slug: string) {
  const lead = await enrolledLead(slug);
  const { personId, steps } = lead;
  await moveStep(steps.connect, "succeeded");
  await moveStep(steps.message_1, "succeeded");
  await f.dueAt(steps.follow_up_1, new Date(REPLIED.getTime() - DAY_MS));
  await run(() => holdForReply(personId, { at: REPLIED }));
  return lead;
}

test("a suggested interested, not_now, not_interested, out_of_office or bounce label changes nothing", async () => {
  await account(ZONE);
  for (const replyLabel of [
    "interested",
    "not_now",
    "not_interested",
    "out_of_office",
    "bounce",
  ] as const) {
    const { personId, enrollmentId } = await heldLead(`replies-suggested-${replyLabel}`);
    const before = [await enrollmentRow(enrollmentId), await statuses(personId)];
    const taken = await label(personId, replyLabel, { suggested: true, returnDate: "2026-11-13" });
    assert.deepEqual(taken, { actions: [], enrollmentIds: [] }, replyLabel);
    assert.deepEqual([await enrollmentRow(enrollmentId), await statuses(personId)], before);
  }
  assert.deepEqual(await notices(), []);
});

test("interested records the label and publishes one notice, with the thread, for the newest enrollment; a second call publishes none", async () => {
  await account(ZONE);
  const { personId, enrollmentId } = await heldLead("replies-interested");
  const taken = await label(personId, "interested");
  assert.deepEqual(taken, {
    actions: ["label_recorded", "notice_published"],
    enrollmentIds: [enrollmentId],
  });
  const kind = "interested";
  const notice = { enrollmentId, personId, kind, threadId: THREAD, ownerUserId: APPROVER };
  assert.deepEqual(await notices(), [notice]);
  const row = await enrollmentRow(enrollmentId);
  assert.deepEqual([row.status, row.replyLabel, row.replyLabelAt], ["replied", kind, REPLIED]);
  assert.deepEqual(
    (await statuses(personId)).slice(2).map(([, status]) => status),
    ["held", "held"],
    "the person stays held",
  );

  assert.deepEqual(await label(personId, "interested"), { actions: [], enrollmentIds: [] });
  assert.deepEqual(await notices(), [notice], "no second notice");
});

test("not_now sets a reminder 30 days after the reply, which the queue run publishes once when due", async () => {
  await account(ZONE);
  const { personId, enrollmentId } = await heldLead("replies-not-now");
  assert.deepEqual((await label(personId, "not_now")).actions, ["label_recorded", "reminder_set"]);
  const remindAt = new Date(REPLIED.getTime() + 30 * DAY_MS);
  const row = await enrollmentRow(enrollmentId);
  assert.deepEqual([row.remindAt, row.remindUserId, row.remindedAt], [remindAt, APPROVER, null]);

  await queueRunStart(new Date(remindAt.getTime() - 1));
  assert.deepEqual(await notices(), [], "not before its time");
  await queueRunStart(remindAt);
  const notice = { enrollmentId, personId, kind: "not_now", threadId: null, ownerUserId: APPROVER };
  assert.deepEqual(await notices(), [notice]);
  assert.deepEqual((await enrollmentRow(enrollmentId)).remindedAt, remindAt);
  await queueRunStart(new Date(remindAt.getTime() + DAY_MS));
  assert.deepEqual(await notices(), [notice], "once");
  assert.deepEqual(await label(personId, "not_now"), { actions: [], enrollmentIds: [] });
});

test("not_interested cancels the held steps and blocks a new enrollment for 180 days, and not after", async () => {
  await account(ZONE);
  const now = Date.now();
  const cases = [
    ["replies-cooling", 179, "cool_down"],
    ["replies-cooled", 181, "enrolled"],
  ] as const;
  for (const [slug, daysAgo, outcome] of cases) {
    const { personId, enrollmentId } = await heldLead(slug);
    const repliedAt = new Date(now - daysAgo * DAY_MS);
    const taken = await label(personId, "not_interested", { repliedAt });
    assert.deepEqual(taken.actions, ["label_recorded", "steps_cancelled", "cool_down_set"]);
    assert.deepEqual((await statuses(personId)).slice(2), [
      ["follow_up_1", "cancelled", "not_interested"],
      ["follow_up_2", "cancelled", "not_interested"],
    ]);
    const coolDownUntil = new Date(repliedAt.getTime() + 180 * DAY_MS);
    assert.deepEqual((await enrollmentRow(enrollmentId)).coolDownUntil, coolDownUntil);

    // Approved again, as Approve leaves the lead: the delivery refuses it while the cool-down holds.
    const actor = { type: "user", id: APPROVER } as const;
    await run(() => recordLeadStatus(personId, "approved", { actor }));
    const again = { sourceEventId: newId("obx"), personId, approvedBy: APPROVER };
    assert.equal(await run((tx) => enrollApproved(tx, again)), outcome, slug);
    const rows = await app().enrollment.count({ where: { personId } });
    assert.equal(rows, outcome === "cool_down" ? 1 : 2, "no row while it holds");
  }
});

test("out_of_office with a Friday return date pauses until Monday 09:00 in the sender's zone, and the first queue run after that opens the step again", async () => {
  await account(ZONE);
  const { personId, enrollmentId, steps } = await heldLead("replies-friday");
  const taken = await label(personId, "out_of_office", { returnDate: "2026-11-13" });
  assert.deepEqual(taken.actions, ["label_recorded", "released", "paused"]);
  // Monday 2026-11-16, 09:00 in Berlin.
  const monday = new Date("2026-11-16T08:00:00Z");
  const row = await enrollmentRow(enrollmentId);
  assert.deepEqual(
    [row.status, row.pausedReason, row.pausedUntil, row.resumedAt, row.endedAt],
    ["paused", "out_of_office", monday, REPLIED, null],
  );
  // The follow-up waits for the pause's end, its own due time long past; the next one for its anchor.
  const followUp = await app().stepExecution.findUniqueOrThrow({
    where: { id: steps.follow_up_1 },
  });
  assert.deepEqual([followUp.status, followUp.dueAt], ["planned", monday]);
  assert.deepEqual((await statuses(personId)).slice(3), [["follow_up_2", "planned", null]]);
  assert.equal((await f.leadOf(personId)).status, "in_campaign");

  const before = new Date(monday.getTime() - 15 * 60_000);
  assert.deepEqual(await queueRunStart(before), [], "still paused");
  assert.equal(await queue(steps.follow_up_1), "passed_over");
  assert.deepEqual(await queueRunStart(new Date(monday.getTime() + 15 * 60_000)), [
    steps.follow_up_1,
  ]);
  assert.equal((await enrollmentRow(enrollmentId)).status, "active");
  assert.equal(await queue(steps.follow_up_1), "opened");
  assert.equal((await f.itemOf(steps.follow_up_1))?.status, "pending");
});

test("out_of_office without a return date pauses seven days after the reply", async () => {
  await account(ZONE);
  const { personId, enrollmentId } = await heldLead("replies-no-date");
  await label(personId, "out_of_office");
  const until = new Date(REPLIED.getTime() + 7 * DAY_MS);
  assert.deepEqual((await enrollmentRow(enrollmentId)).pausedUntil, until);
});

test("the pause's end counts business days in the sender's zone, holidays not counted", () => {
  const until = (returnDate: string, timeZone = ZONE) =>
    outOfOfficeUntil({ returnDate, repliedAt: REPLIED, timeZone }).toISOString();
  assert.equal(until("2026-11-13"), "2026-11-16T08:00:00.000Z", "Friday: Monday");
  assert.equal(until("2026-11-14"), "2026-11-16T08:00:00.000Z", "Saturday: Monday");
  assert.equal(until("2026-11-12"), "2026-11-13T08:00:00.000Z", "Thursday: Friday");
  // Berlin's clocks went back on Sunday 2026-10-25: 09:00 on the Monday is 08:00 UTC.
  assert.equal(until("2026-10-23"), "2026-10-26T08:00:00.000Z", "over the change");
  assert.equal(until("2026-12-24", "America/New_York"), "2026-12-25T14:00:00.000Z", "a holiday");
  const none = outOfOfficeUntil({ returnDate: null, repliedAt: REPLIED, timeZone: ZONE });
  assert.equal(none.getTime() - REPLIED.getTime(), 7 * DAY_MS);
});

test("a later label first undoes the earlier one's reminder or out-of-office pause, then acts; a sent reminder stays", async () => {
  await account(ZONE);
  const reminded = await heldLead("replies-undo-reminder");
  await label(reminded.personId, "not_now");
  assert.deepEqual((await label(reminded.personId, "interested")).actions, [
    "reminder_cleared",
    "label_recorded",
    "notice_published",
  ]);
  const cleared = await enrollmentRow(reminded.enrollmentId);
  assert.deepEqual([cleared.remindAt, cleared.remindUserId], [null, null]);

  const away = await heldLead("replies-undo-pause");
  await label(away.personId, "out_of_office", { returnDate: "2026-11-13" });
  assert.deepEqual((await label(away.personId, "not_interested")).actions, [
    "pause_held_again",
    "label_recorded",
    "steps_cancelled",
    "cool_down_set",
  ]);
  const held = await enrollmentRow(away.enrollmentId);
  assert.deepEqual(
    [held.status, held.pausedReason, held.pausedUntil, held.replyLabel],
    ["replied", null, null, "not_interested"],
  );
  assert.deepEqual((await statuses(away.personId)).slice(2), [
    ["follow_up_1", "cancelled", "not_interested"],
    ["follow_up_2", "cancelled", "not_interested"],
  ]);

  const sent = await heldLead("replies-sent-reminder");
  await label(sent.personId, "not_now");
  await queueRunStart(new Date(REPLIED.getTime() + 31 * DAY_MS));
  const later = { repliedAt: new Date(REPLIED.getTime() + 32 * DAY_MS) };
  assert.deepEqual((await label(sent.personId, "interested", later)).actions, [
    "label_recorded",
    "notice_published",
  ]);
  assert.notEqual((await enrollmentRow(sent.enrollmentId)).remindedAt, null);
});

test("a second out_of_office call for the same reply changes nothing; a new reply's label acts again", async () => {
  await account(ZONE);
  const { personId, enrollmentId } = await heldLead("replies-repeat");
  await label(personId, "out_of_office", { returnDate: "2026-11-13" });
  const first = await enrollmentRow(enrollmentId);
  assert.deepEqual(await label(personId, "out_of_office", { returnDate: "2026-11-20" }), {
    actions: [],
    enrollmentIds: [],
  });
  assert.deepEqual(await enrollmentRow(enrollmentId), first);

  // Another reply, a week later, held by inbox's store and labelled again: paused anew.
  const repliedAt = new Date(REPLIED.getTime() + 7 * DAY_MS + HOUR_MS);
  await run(() => holdForReply(personId, { at: repliedAt }));
  const again = await label(personId, "out_of_office", { repliedAt });
  assert.deepEqual(again.actions, ["label_recorded", "released", "paused"]);
  const row = await enrollmentRow(enrollmentId);
  assert.deepEqual(
    [row.pausedUntil, row.resumedAt],
    [new Date(repliedAt.getTime() + 7 * DAY_MS), repliedAt],
  );
});

test("bounce and other record the label alone, and the person stays held", async () => {
  await account(ZONE);
  for (const replyLabel of ["bounce", "other"] as const) {
    const { personId, enrollmentId } = await heldLead(`replies-${replyLabel}`);
    const before = await statuses(personId);
    assert.deepEqual((await label(personId, replyLabel)).actions, ["label_recorded"], replyLabel);
    const row = await enrollmentRow(enrollmentId);
    assert.deepEqual([row.status, row.replyLabel], ["replied", replyLabel]);
    assert.deepEqual(await statuses(personId), before);
  }
});

test("a label for a person with no held step changes nothing but an opt-out; an input off its rule is refused", async () => {
  const { id: accountId } = await account(ZONE);
  const { personId } = await enrolledLead("replies-active");
  await createOutreach(WORKSPACE, { senderAccountId: accountId, personId });
  const before = await statuses(personId);
  assert.deepEqual(await label(personId, "interested"), { actions: [], enrollmentIds: [] });
  assert.deepEqual(await label(personId, "out_of_office"), { actions: [], enrollmentIds: [] });
  assert.deepEqual(await statuses(personId), before);
  assert.deepEqual(await notices(), []);
  await assert.rejects(label(personId, "interested", { returnDate: "2026-02-30" }), {
    message: "applyReplyLabel: returnDate off its rule",
  });
  await assert.rejects(label(" ", "interested"), { code: "person_not_found" });
});

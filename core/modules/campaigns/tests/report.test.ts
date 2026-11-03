// The "Done when" report's figures (beta-p7-020; README.md "Commands"), each called as the command
// calls it, in a workspace's tenant run, on rows seeded in two workspaces of this file's schema: a
// planted violation of each zero beside a clean send, and the boundaries (the edit ratio, the 7-day
// age, the 21-day span, weekdays in the sender's zone, a suppression entry added after and removed
// before a send). Each figure answers its own workspace's rows only. The command and its lines are
// tests/report-cli.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { ids as approvalsIds } from "@whytide/approvals";
import { createApprovalItem } from "@whytide/approvals/testing";
import { erasePerson as eraseContact } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { ids as linkedinIds } from "@whytide/linkedin";
import { createConnectedAccount, useLinkedinClient } from "@whytide/linkedin/testing";
import { newId } from "@whytide/platform";
import { erasePerson } from "../domain/erase.ts";
import { acceptanceBySender, acceptanceShare } from "../domain/report/acceptance.ts";
import { sendsWithoutApproval, type Violation } from "../domain/report/approval.ts";
import { decidedWeekdays, weekdaysBefore } from "../domain/report/decisions.ts";
import { duplicateSends, type KeyedStep, sharedKeys } from "../domain/report/duplicates.ts";
import { editCounts, editShare } from "../domain/report/edits.ts";
import { readSends } from "../domain/report/sends.ts";
import { senderSpans } from "../domain/report/span.ts";
import { actionsAgainstSuppressed } from "../domain/report/suppressed.ts";
import { ids } from "../ids.ts";
import {
  DAY_MS,
  EPOCH,
  HOUR_MS,
  MINUTE_MS,
  type ReportFixture,
  reportFixture,
  TEXT,
} from "./report-fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const A = reportFixture("wsp_campaigns_report_a");
const B = reportFixture("wsp_campaigns_report_b");

/** A send's instant where a test sets one: a Tuesday. */
const T = new Date("2026-10-20T10:00:00Z");
/** `minutes` after T; a negative number before it. */
const after = (minutes: number) => new Date(T.getTime() + minutes * MINUTE_MS);
const sendsOf = (fx: ReportFixture) => fx.run(() => readSends({ since: EPOCH }));
/** The violations as `<step> <reason>`, sorted. */
const reasons = (found: readonly Violation[]) =>
  found.map(({ stepExecutionId, reason }) => `${stepExecutionId} ${reason}`).sort();

/** The step's message queued, its draft ready with TEXT, edited at `ratio` if given, approved. */
async function approvedMessage(fx: ReportFixture, id: string, ratio: number | null) {
  await fx.dueAt(id, new Date());
  assert.equal(await fx.queue(id), "opened");
  await fx.draftReady(id, TEXT);
  if (ratio !== null) await edited(fx, id, `${TEXT} Thanks.`, ratio);
  await fx.approveItem(id);
}
/** The step's draft edited by its approver to `editedText`, as the edit leaves it. */
async function edited(fx: ReportFixture, id: string, editedText: string, editRatio: number) {
  await fx.app().messageDraft.updateMany({
    where: { stepExecutionId: id },
    data: { editedText, editedByUser: true, editRatio },
  });
}

test("sends_without_approval: a send whose step has no approved item, another item or hash than the approval's, or an approval after it, counts with the reason; a clean send does not, nor another workspace's", async () => {
  await A.account();
  await B.account();
  const clean = await A.enrolledLead("report-clean");
  await A.approvedSend(clean.steps.connect);
  const pending = await A.enrolledLead("report-pending");
  assert.equal(await A.queue(pending.steps.connect), "opened");
  await A.sendStep(pending.steps.connect, { at: T });
  const otherItem = await A.enrolledLead("report-other-item");
  await A.approvedSend(otherItem.steps.connect, { item: newId(approvalsIds.approval_item) });
  const otherHash = await A.enrolledLead("report-other-hash");
  await A.approvedSend(otherHash.steps.connect, { hash: "0".repeat(64) });
  const early = await A.enrolledLead("report-early");
  const beforeApproval = new Date(Date.now() - HOUR_MS);
  await A.approvedSend(early.steps.connect, { at: beforeApproval });
  const theirs = await B.enrolledLead("report-theirs");
  await B.sendStep(theirs.steps.connect, { at: T });

  const without = (fx: ReportFixture) =>
    fx.run(async () => sendsWithoutApproval((await readSends({ since: EPOCH })).sends));
  const ours = await without(A);
  assert.deepEqual(
    reasons(ours),
    [
      `${pending.steps.connect} no_approval`,
      `${otherItem.steps.connect} item_mismatch`,
      `${otherHash.steps.connect} item_mismatch`,
      `${early.steps.connect} approved_after_send`,
    ].sort(),
  );
  const late = ours.find(({ stepExecutionId }) => stepExecutionId === early.steps.connect);
  assert.equal(late?.at.getTime(), beforeApproval.getTime(), "the send's instant");
  assert.deepEqual(reasons(await without(B)), [`${theirs.steps.connect} no_approval`]);
});

test("send_step_missing: a row naming a step that no longer exists, or none, whatever its kind, is listed apart from the sends, as a step erased with its person leaves one", async () => {
  const { id: accountId } = await A.account();
  const kept = await A.enrolledLead("report-kept");
  const keptRow = await A.logSend({ accountId, stepExecutionId: kept.steps.connect, at: after(0) });
  const erased = await A.enrolledLead("report-erased");
  const erasedStep = erased.steps.connect;
  const erasedRow = await A.logSend({ accountId, stepExecutionId: erasedStep, at: after(1) });
  const deleted = await A.run(() => erasePerson(erased.personId));
  assert.deepEqual(deleted, { step_executions: 4, enrollments: 1 });
  const unknown = newId(ids.step_execution);
  const unknownRow = await A.logSend({
    ...{ accountId, stepExecutionId: unknown, at: after(2) },
    kind: "message",
  });
  const noStep = await A.logSend({ accountId, stepExecutionId: null, at: after(3) });
  const gone = newId(ids.step_execution);
  const withdrawal = await A.logSend({
    ...{ accountId, stepExecutionId: gone, at: after(4) },
    kind: "withdraw",
  });
  // A withdrawal of a step that exists: neither a send the zeros check nor a missing step.
  await A.logSend({
    ...{ accountId, stepExecutionId: kept.steps.connect, at: after(5) },
    kind: "withdraw",
  });

  const { rows, sends, missing } = await sendsOf(A);
  assert.equal(rows.length, 6);
  assert.deepEqual(
    sends.map(({ row, step }) => [row.id, step.id, step.personId]),
    [[keptRow, kept.steps.connect, kept.personId]],
  );
  assert.deepEqual(
    missing.map(({ id, stepExecutionId, kind }) => [id, stepExecutionId, kind]),
    [
      [erasedRow, erasedStep, "invite"],
      [unknownRow, unknown, "message"],
      [noStep, null, "invite"],
      [withdrawal, gone, "withdraw"],
    ],
  );
});

test("actions_against_suppressed: a send to a person opted out or on the never-contact list at its instant counts with the reason; an entry made after it or lifted before it does not, nor a person erased since the send", async () => {
  const { id: accountId } = await A.account();
  /** A lead whose connection request went out at T. */
  const sentAtT = async (slug: string) => {
    const lead = await A.enrolledLead(slug);
    await A.logSend({ accountId, stepExecutionId: lead.steps.connect, at: T });
    return lead;
  };
  const optedOut = await sentAtT("report-opted-out");
  await A.suppress(optedOut.personId, { createdAt: after(-60) });
  const blocked = await sentAtT("report-blocked");
  await A.suppress(blocked.personId, { layer: "blocklist", createdAt: after(-60) });
  const later = await sentAtT("report-later");
  await A.suppress(later.personId, { createdAt: after(1) });
  const lifted = await sentAtT("report-lifted");
  await A.suppress(lifted.personId, {
    ...{ layer: "blocklist", createdAt: after(-120) },
    removedAt: after(-1),
  });
  await sentAtT("report-clear");
  // contacts' eraser alone: the step stays, and suppressedAt answers person_not_found.
  const erased = await sentAtT("report-erased-since");
  await A.suppress(erased.personId, { createdAt: after(-60) });
  await A.run(() => eraseContact(erased.personId));

  const found = await A.run(async () =>
    actionsAgainstSuppressed((await readSends({ since: EPOCH })).sends),
  );
  assert.deepEqual(
    reasons(found),
    [`${optedOut.steps.connect} opted_out`, `${blocked.steps.connect} never_contact_person`].sort(),
  );
  assert.ok(
    found.every(({ at }) => at.getTime() === T.getTime()),
    "the send's instant",
  );
});

test("duplicate_sends: a step with two ok invite or message rows is listed once with both, also when the first went out before the period; an invite and its withdrawal are not; each workspace has its own", async () => {
  const { id: accountId } = await A.account();
  const twice = await A.enrolledLead("report-twice");
  const first = await A.logSend({ accountId, stepExecutionId: twice.steps.connect, at: after(0) });
  await A.logSend({ accountId, stepExecutionId: null, at: after(1) });
  const second = await A.logSend({ accountId, stepExecutionId: twice.steps.connect, at: after(5) });
  const withdrawn = await A.enrolledLead("report-withdrawn");
  await A.logSend({ accountId, stepExecutionId: withdrawn.steps.connect, at: after(2) });
  await A.logSend({
    ...{ accountId, stepExecutionId: withdrawn.steps.connect, at: after(3) },
    kind: "withdraw",
  });
  const { id: theirAccount } = await B.account();
  const theirs = await B.enrolledLead("report-their-twice");
  const theirRow = (at: Date) =>
    B.logSend({ accountId: theirAccount, stepExecutionId: theirs.steps.connect, at });
  const theirRows = [await theirRow(after(0)), await theirRow(after(1))];

  const duplicatesOf = (fx: ReportFixture, since: Date) => fx.run(() => duplicateSends({ since }));
  const ours = [{ stepExecutionId: twice.steps.connect, rows: [first, second] }];
  assert.deepEqual(await duplicatesOf(A, EPOCH), ours);
  assert.deepEqual(await duplicatesOf(A, after(4)), ours, "the second send is in the period");
  assert.deepEqual(await duplicatesOf(A, after(6)), [], "neither send is in the period");
  const their = [{ stepExecutionId: theirs.steps.connect, rows: theirRows }];
  assert.deepEqual(await duplicatesOf(B, EPOCH), their);
});

test("duplicate_sends by key: a key two succeeded steps hold is listed by the first with the others when one ran in the period; a key held once, or only before the period, is not", () => {
  const step = (id: string, idempotencyKey: string, at: string): KeyedStep => ({
    ...{ id, idempotencyKey },
    executedAt: new Date(at),
  });
  const since = new Date("2026-10-01T00:00:00Z");
  const steps = [
    step("sx_old_1", "key_old", "2026-09-01T00:00:00Z"),
    step("sx_old_2", "key_old", "2026-09-02T00:00:00Z"),
    step("sx_cross_1", "key_cross", "2026-09-30T23:00:00Z"),
    step("sx_cross_2", "key_cross", "2026-10-02T00:00:00Z"),
    step("sx_once", "key_once", "2026-10-03T00:00:00Z"),
    step("sx_three_1", "key_three", "2026-10-04T00:00:00Z"),
    step("sx_three_2", "key_three", "2026-10-05T00:00:00Z"),
    step("sx_three_3", "key_three", "2026-10-06T00:00:00Z"),
  ];
  assert.deepEqual(sharedKeys(steps, since), [
    { stepExecutionId: "sx_cross_1", rows: ["sx_cross_2"] },
    { stepExecutionId: "sx_three_1", rows: ["sx_three_2", "sx_three_3"] },
  ]);
  assert.equal(sharedKeys(steps, new Date("2026-10-07T00:00:00Z")).length, 0);
  assert.equal(sharedKeys(steps, EPOCH).length, 3);
});

test("drafts_small_edits: of the drafts approved in the period, those unedited and those edited at a ratio of 0.2 or less, not 0.21; an invite approved with an empty note is left out", async () => {
  await A.account();
  await B.account();
  const bare = await A.enrolledLead("report-edit-bare");
  await A.approved(bare.steps.connect);
  const noted = await A.enrolledLead("report-edit-note");
  assert.equal(await A.queue(noted.steps.connect), "opened");
  await edited(A, noted.steps.connect, "Noor, glad to connect.", 1);
  await A.approveItem(noted.steps.connect);
  const messages = [
    ["report-edit-none", null],
    ["report-edit-small", 0.2],
    ["report-edit-more", 0.21],
  ] as const;
  for (const [slug, ratio] of messages) {
    await approvedMessage(A, (await A.enrolledLead(slug)).steps.message_1, ratio);
  }
  await approvedMessage(B, (await B.enrolledLead("report-edit-theirs")).steps.message_1, 0.1);

  const stats = await A.run(() => editCounts({ since: EPOCH }));
  assert.deepEqual(stats, { approved: 4, unedited: 1, smallEdits: 1 });
  assert.equal(editShare(stats), 0.5);
  assert.deepEqual(await B.run(() => editCounts({ since: EPOCH })), {
    ...{ approved: 1, unedited: 0 },
    smallEdits: 1,
  });
  const tomorrow = new Date(Date.now() + DAY_MS);
  const none = await A.run(() => editCounts({ since: tomorrow }));
  assert.deepEqual(none, { approved: 0, unedited: 0, smallEdits: 0 });
  assert.equal(editShare(none), null);
});

test("acceptance_rate: of the connection requests sent in the period and at least 7 days before the run, the share accepted, by sender; a fresher invite is left out, accepted or not", async () => {
  const { id: first } = await A.account();
  const { id: second } = await createConnectedAccount(A.workspaceId);
  const now = new Date("2026-10-28T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  /** A connection request sent `days` ago by the sender, accepted `acceptedDays` ago if given. */
  async function invite(slug: string, sender: string, days: number, acceptedDays?: number) {
    const lead = await A.enrolledLead(slug);
    const acceptedAt = acceptedDays === undefined ? null : ago(acceptedDays);
    await A.app().stepExecution.update({
      where: { id: lead.steps.connect },
      data: { status: "succeeded", senderAccountId: sender, executedAt: ago(days), acceptedAt },
    });
    return lead;
  }
  await invite("report-accepted", first, 8, 6);
  await invite("report-week", first, 7);
  await invite("report-older", first, 10);
  await invite("report-fresh", first, 6, 5);
  await invite("report-second", second, 9, 8);
  // A message that went out is no connection request.
  const messaged = await invite("report-messaged", first, 12, 11);
  await A.app().stepExecution.update({
    where: { id: messaged.steps.message_1 },
    data: { status: "succeeded", executedAt: ago(9) },
  });

  const sentBefore = ago(7);
  /** The senders' counts of the period, by sender, which come in the order of their ids. */
  async function countsSince(since: Date) {
    const counts = await A.run(() => acceptanceBySender({ since, sentBefore }));
    const order = counts.map(({ senderAccountId }) => senderAccountId);
    assert.deepEqual(order, [first, second].sort());
    return Object.fromEntries(counts.map(({ senderAccountId: id, ...count }) => [id, count]));
  }
  assert.deepEqual(await countsSince(EPOCH), {
    [first]: { sent: 4, accepted: 2 },
    [second]: { sent: 1, accepted: 1 },
  });
  assert.deepEqual(await countsSince(ago(9)), {
    [first]: { sent: 2, accepted: 1 },
    [second]: { sent: 1, accepted: 1 },
  });
  assert.equal(acceptanceShare({ sent: 4, accepted: 1 }), 0.25);
  assert.equal(acceptanceShare({ sent: 0, accepted: 0 }), null);
  assert.deepEqual(await B.run(() => acceptanceBySender({ since: EPOCH, sentBefore })), []);
});

test("senders_three_weeks: each sender's first and last invite or message as UTC days, and the days between: 21 counts, 20 does not; a withdrawal is no outreach", async () => {
  const { id: first } = await A.account();
  const { id: second } = await createConnectedAccount(A.workspaceId);
  const row = (accountId: string, at: string, kind: "invite" | "message" | "withdraw") =>
    A.logSend({ accountId, stepExecutionId: null, at: new Date(at), kind });
  // 20 days and an hour apart, on days 21 apart.
  await row(first, "2026-09-01T23:30:00Z", "invite");
  await row(first, "2026-09-10T12:00:00Z", "message");
  await row(first, "2026-09-22T00:30:00Z", "message");
  // 20 days and 23 hours apart, on days 20 apart; the withdrawal after them is not counted.
  await row(second, "2026-09-01T00:30:00Z", "invite");
  await row(second, "2026-09-21T23:30:00Z", "message");
  await row(second, "2026-09-25T10:00:00Z", "withdraw");

  const { rows } = await sendsOf(A);
  const expected = [
    { senderAccountId: first, first: "2026-09-01", last: "2026-09-22", days: 21 },
    { senderAccountId: second, first: "2026-09-01", last: "2026-09-21", days: 20 },
  ].sort((x, y) => (x.senderAccountId < y.senderAccountId ? -1 : 1));
  assert.deepEqual(senderSpans(rows), expected);
  assert.deepEqual(senderSpans((await sendsOf(B)).rows), []);
});

test("decision_days: of the weekdays among the 7 local days before the run's day in the sender's zone, those with a decision, approved or skipped; another workspace with none counts UTC's", async () => {
  const { id: tokyo } = await A.account("Asia/Tokyo");
  // Wednesday 12:00 in Tokyo: the window is Wednesday 21 to Tuesday 27, five weekdays.
  const now = new Date("2026-10-28T03:00:00Z");
  const decided = (decidedAt: string, status: "approved" | "skipped" | "pending" = "approved") =>
    createApprovalItem({
      ...{ workspaceId: A.workspaceId, personId: "per_01JABCDEFGHJKMNPQRSTVWXYZ0" },
      ...{ senderAccountId: tokyo, stepExecutionId: newId(ids.step_execution), stepKey: "connect" },
      ...{ status, decidedAt: new Date(decidedAt) },
    });
  await decided("2026-10-27T01:00:00Z"); // Tuesday 10:00
  await decided("2026-10-26T05:00:00Z", "skipped"); // Monday 14:00
  await decided("2026-10-23T08:00:00Z"); // Friday 17:00
  await decided("2026-10-20T16:00:00Z"); // Wednesday 21, 01:00: Tuesday 20 in UTC
  await decided("2026-10-24T03:00:00Z"); // Saturday: no weekday
  await decided("2026-10-27T16:00:00Z"); // Wednesday 28, 01:00: the run's day
  await decided("2026-10-22T03:00:00Z", "pending"); // Thursday: no decision yet

  const window = { now, days: 7 };
  assert.deepEqual(await A.run(() => decidedWeekdays(window)), { decided: 4, weekdays: 5 });
  assert.deepEqual(await B.run(() => decidedWeekdays(window)), { decided: 0, weekdays: 5 });
  // A sender linkedin no longer holds: its decisions are read in UTC, approvals' fallback.
  const gone = newId(linkedinIds.sender_account);
  await createApprovalItem({
    ...{ workspaceId: B.workspaceId, personId: "per_01JABCDEFGHJKMNPQRSTVWXYZ0" },
    ...{ senderAccountId: gone, stepExecutionId: newId(ids.step_execution), status: "approved" },
    decidedAt: new Date("2026-10-22T23:30:00Z"), // Thursday in UTC, Friday in Tokyo
  });
  assert.deepEqual(await B.run(() => decidedWeekdays(window)), { decided: 1, weekdays: 5 });
  assert.deepEqual(weekdaysBefore("2026-10-28", 7), [
    ...["2026-10-27", "2026-10-26", "2026-10-23", "2026-10-22", "2026-10-21"],
  ]);
  // On a Monday, the two days before are a weekend; the third is Friday.
  assert.deepEqual(weekdaysBefore("2026-10-26", 2), []);
  assert.deepEqual(weekdaysBefore("2026-10-26", 3), ["2026-10-23"]);
});

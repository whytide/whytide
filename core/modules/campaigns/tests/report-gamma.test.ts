// gamma's "Done when" lines of `pnpm campaigns:report` (gamma-p7-050, LinkedIn's part; README.md
// "Commands"): runReport against the worktree's database, in a schema of its own (withTestDb), its
// clock fixed, on rows written in their end states in two workspaces: linkedin's log and health
// events, steps sent, approvals, contacts' review decisions and never-contact entries. One test per
// line, each LinkedIn zero broken once, the erased person, a month boundary; then the figures' pure
// parts: the ratios, the days and weeks, the streak. Email's lines wait for the email phase.
import assert from "node:assert/strict";
import test from "node:test";
import { ids as contactsIds, erasePerson as eraseContact } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { ids as linkedinIds } from "@whytide/linkedin";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { newId } from "@whytide/platform";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { DONE_WHEN_MIN_AGENTS, DONE_WHEN_MIN_SENDERS } from "../cli/constants.ts";
import { runReport } from "../cli/report.ts";
import { useClock } from "../domain/clock.ts";
import { type ActiveSend, activeDays } from "../domain/report/activity.ts";
import { daysFrom, isoWeekOf, isWeekday, monthOf } from "../domain/report/days.ts";
import { uneditedShare } from "../domain/report/edits.ts";
import { per100 } from "../domain/report/restrictions.ts";
import { reviewShare } from "../domain/report/reviews.ts";
import { longestStreak } from "../domain/report/streak.ts";
import { activeWeeks } from "../domain/report/weeks.ts";
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
const app = asRole("app");
useTenancyClient(app);
useLinkedinClient(app);
useHashSalt("test-salt-".repeat(4));
const A = reportFixture("wsp_campaigns_gamma_a");
const B = reportFixture("wsp_campaigns_gamma_b");
/** The fixed run of the figures' tests: Wednesday 4 March 2026, noon UTC. */
const NOW = new Date("2026-03-04T12:00:00Z");
/** The run of the zeros' tests: a day after the approvals, which date now. */
const AFTER_APPROVALS = () => new Date(Date.now() + DAY_MS);
const MIN = { campaigns: DONE_WHEN_MIN_AGENTS, senders: DONE_WHEN_MIN_SENDERS };

/** The command at `now`: its exit code and its lines. */
async function report(now: Date, ...args: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  useClock(() => now);
  try {
    const code = await runReport(args, (line) => lines.push(line), { client: app });
    return { code, lines };
  } finally {
    useClock(undefined);
  }
}
/** The lines that start with the code. */
const linesOf = (lines: readonly string[], code: string) =>
  lines.filter((line) => line.startsWith(`${code}: `));
/** A sender account's id, as linkedin makes one: the log keeps the id alone. */
const accountId = () => newId(linkedinIds.sender_account);
/** A step's id whose step no longer exists, as an erased person's: its sender still counts. */
const goneStep = () => newId(ids.step_execution);
/** linkedin's health event into `toState` at `at`, as applyHealth records one. */
async function healthEvent(
  fx: ReportFixture,
  senderId: string,
  toState: "restricted" | "checkpoint",
  at: Date,
): Promise<void> {
  const trigger = toState === "restricted" ? "limit_reached" : "checkpoint";
  await app.senderHealthEvent.create({
    data: {
      ...{ id: newId(linkedinIds.sender_health_event), workspaceId: fx.workspaceId, senderId },
      ...{ fromState: "healthy", toState, trigger, metrics: {}, createdAt: at },
    },
  });
}
/** A lead's review decision at `at`, made its latest, as contacts' reviewLead leaves the rows. */
async function reviewed(
  fx: ReportFixture,
  personId: string,
  decision: "good_lead" | "not_a_fit",
  at: Date,
): Promise<void> {
  const reasonCode = decision === "not_a_fit" ? "company_competitor" : null;
  await app.reviewDecision.create({
    data: {
      ...{
        id: newId(contactsIds.review_decision),
        workspaceId: fx.workspaceId,
        personId,
        decision,
        reasonCode,
      },
      ...{ decidedBy: "usr_campaigns_approver", decidedAt: at },
    },
  });
  await app.lead.updateMany({
    where: { workspaceId: fx.workspaceId, personId },
    data: { reviewStatus: decision, reviewedAt: at },
  });
}

test("actions_against_suppressed, LinkedIn's: an invite to a person opted out, or blocked on LinkedIn, counts once and exits 1; a block on email alone does not", async () => {
  await A.account();
  const sent = async (slug: string) => {
    const lead = await A.enrolledLead(slug);
    const { at } = await A.approvedSend(lead.steps.connect);
    return { ...lead, step: lead.steps.connect, before: new Date(at.getTime() - HOUR_MS) };
  };
  const optedOut = await sent("gamma-opted-out");
  await A.suppress(optedOut.personId, { createdAt: optedOut.before });
  const onLinkedin = await sent("gamma-blocked-linkedin");
  const linkedinOnly = { layer: "blocklist", channel: "linkedin" } as const;
  await A.suppress(onLinkedin.personId, { ...linkedinOnly, createdAt: onLinkedin.before });
  const onEmail = await sent("gamma-blocked-email");
  const emailOnly = { layer: "blocklist", channel: "email" } as const;
  await A.suppress(onEmail.personId, { ...emailOnly, createdAt: onEmail.before });

  const { code, lines } = await report(AFTER_APPROVALS(), "--workspace", A.workspaceId);
  assert.equal(code, 1);
  assert.deepEqual(linesOf(lines, "sends_without_approval"), ["sends_without_approval: 0"]);
  assert.deepEqual(linesOf(lines, "actions_against_suppressed"), ["actions_against_suppressed: 2"]);
  const counted = linesOf(lines, "violation").map((line) => line.split(" ").slice(3, 5).join(" "));
  assert.deepEqual(
    counted.sort(),
    [`${onLinkedin.step} never_contact_person`, `${optedOut.step} opted_out`].sort(),
  );
  assert.ok(!lines.join("\n").includes(onEmail.step), "the email block is no violation");
});

test("sends_person_erased: a send whose person was erased since prints its step and instant after the suppression zero, which stays 0, and exits 0", async () => {
  await A.account();
  const lead = await A.enrolledLead("gamma-erased");
  const { at } = await A.approvedSend(lead.steps.connect);
  await A.suppress(lead.personId, { createdAt: new Date(at.getTime() - HOUR_MS) });
  await A.run(() => eraseContact(lead.personId));

  const { code, lines } = await report(AFTER_APPROVALS(), "--workspace", A.workspaceId);
  const zero = lines.indexOf("actions_against_suppressed: 0");
  assert.ok(zero > 0, lines.join("\n"));
  assert.equal(lines[zero + 1], `sends_person_erased: ${lead.steps.connect} ${at.toISOString()}`);
  assert.equal(linesOf(lines, "sends_person_erased").length, 1);
  assert.equal(code, 0);
});

test("sends_without_approval, first touches as the gate stored them: one the mode approved counts in either mode, one approved by no one counts in either mode; a follow-up the mode approved does not", async () => {
  await A.account();
  const leads: { steps: Record<string, string> }[] = [];
  for (const slug of ["follow-up", "first-ft", "first-re", "bare-re", "bare-ft"]) {
    leads.push(await A.enrolledLead(`gamma-mode-${slug}`));
  }
  const [followUp, firstFt, firstRe, bareRe, bareFt] = leads.map(({ steps }) => steps.follow_up_1);
  if (!followUp || !firstFt || !firstRe || !bareRe || !bareFt) throw new Error("five leads");
  await A.setMode("review_first_touches", EPOCH);
  await A.modeApprovedSend(followUp);
  // The gate's stored first touch decides, not the step's position (review-gaps): the earlier
  // messages of these enrollments are `succeeded`, yet the sends were stored as first touches.
  await A.modeApprovedSend(firstFt, { approval: { firstTouch: true } });
  await A.modeApprovedSend(firstRe, { approval: { firstTouch: true, mode: "review_everything" } });
  const at = new Date(Date.now() - MINUTE_MS);
  for (const [step, mode] of [
    [bareRe, "review_everything"],
    [bareFt, "review_first_touches"],
  ] as const) {
    await A.dueAt(step, new Date());
    assert.equal(await A.queue(step), "opened");
    await A.sendStep(step, { at, jitChecks: { approval: { mode, firstTouch: true } } });
  }

  const { code, lines } = await report(AFTER_APPROVALS(), "--workspace", A.workspaceId);
  assert.equal(code, 1);
  const counted = linesOf(lines, "violation").map((line) => {
    const [, , , step, reason, , mode] = line.split(" ");
    return `${step} ${reason} ${mode}`;
  });
  assert.deepEqual(
    counted.sort(),
    [
      `${firstFt} mode_not_allowed review_first_touches`,
      `${firstRe} mode_not_allowed review_everything`,
      `${bareRe} no_approval review_everything`,
      `${bareFt} no_approval review_first_touches`,
    ].sort(),
  );
  assert.deepEqual(linesOf(lines, "sends_without_approval_mode"), [
    "sends_without_approval_mode: review_everything 2",
    "sends_without_approval_mode: review_first_touches 2",
  ]);
});

test("restrictions_per_100: 1 account restricted of 40 active gives 2.5; a restriction and a send on the 1st, midnight UTC, count in the new month; a checkpoint is no restriction", async () => {
  await A.owned();
  const accounts = Array.from({ length: 40 }, accountId);
  const [first, second, third] = accounts;
  if (!first || !second || !third) throw new Error("40 accounts");
  for (const account of accounts) {
    await A.logSend({
      accountId: account,
      stepExecutionId: goneStep(),
      at: new Date("2026-02-10T10:00:00Z"),
    });
  }
  const lastOfFebruary = new Date("2026-03-01T00:00:00Z").getTime() - 1;
  await healthEvent(A, first, "restricted", new Date("2026-02-20T09:00:00Z"));
  await healthEvent(A, first, "restricted", new Date(lastOfFebruary));
  await healthEvent(A, third, "checkpoint", new Date("2026-02-21T09:00:00Z"));
  await healthEvent(A, second, "restricted", new Date("2026-03-01T00:00:00Z"));
  await A.logSend({
    accountId: first,
    stepExecutionId: goneStep(),
    at: new Date("2026-03-01T00:00:00Z"),
  });
  await A.logSend({
    accountId: second,
    stepExecutionId: goneStep(),
    at: new Date("2026-03-02T10:00:00Z"),
  });

  const { lines } = await report(NOW, "--workspace", A.workspaceId, "--since", "2026-02-01");
  assert.deepEqual(linesOf(lines, "restrictions_per_100"), [
    "restrictions_per_100: 2026-02 2.500 restricted=1 active=40 target=2 permanent: check by hand",
    "restrictions_per_100: 2026-03 50.000 restricted=1 active=2 target=2 permanent: check by hand",
  ]);
});

test("review_approval: of each lead's latest decision in the 30 days before the run, the share Good lead; an older one and an earlier decision since changed are left out", async () => {
  const days = (n: number) => new Date(NOW.getTime() - n * DAY_MS);
  await A.account();
  await B.account();
  const persons: string[] = [];
  for (const slug of ["good-1", "good-2", "good-3", "not-a-fit", "old", "changed"]) {
    persons.push((await A.enrolledLead(`gamma-review-${slug}`)).personId);
  }
  const [good1, good2, good3, notAFit, old, changed] = persons;
  if (!good1 || !good2 || !good3 || !notAFit || !old || !changed) throw new Error("six leads");
  for (const person of [good1, good2, good3]) await reviewed(A, person, "good_lead", days(3));
  await reviewed(A, notAFit, "not_a_fit", days(29));
  await reviewed(A, old, "good_lead", days(31));
  await reviewed(A, changed, "not_a_fit", days(10));
  await reviewed(A, changed, "good_lead", days(5));
  const another = await B.enrolledLead("gamma-review-other");
  await reviewed(B, another.personId, "not_a_fit", days(1));

  const ours = await report(NOW, "--workspace", A.workspaceId);
  assert.deepEqual(linesOf(ours.lines, "review_approval"), [
    "review_approval: 0.800 approved=4 rejected=1 target=0.6",
  ]);
  const both = await report(NOW);
  assert.deepEqual(linesOf(both.lines, "review_approval"), [
    "review_approval: 0.667 approved=4 rejected=2 target=0.6",
  ]);
});

test("unedited_approvals: of the items a person approved, those without an edit; a follow-up the mode approved in review_first_touches is left out", async () => {
  await A.account();
  const approve = async (slug: string, edit: boolean) => {
    const step = (await A.enrolledLead(slug)).steps.message_1;
    await A.dueAt(step, new Date());
    assert.equal(await A.queue(step), "opened");
    await A.draftReady(step, TEXT);
    if (edit) {
      await A.app().messageDraft.updateMany({
        where: { stepExecutionId: step },
        data: { editedText: `${TEXT} Thanks.`, editedByUser: true, editRatio: 0.1 },
      });
    }
    await A.approveItem(step);
  };
  await approve("gamma-unedited", false);
  await approve("gamma-edited", true);
  await A.setMode("review_first_touches", EPOCH);
  await A.modeApprovedSend((await A.enrolledLead("gamma-by-mode")).steps.follow_up_1);

  const { lines } = await report(AFTER_APPROVALS(), "--workspace", A.workspaceId);
  assert.deepEqual(linesOf(lines, "unedited_approvals"), [
    "unedited_approvals: 0.500 approved=2 unedited=1 target=0.5",
  ]);
  assert.deepEqual(linesOf(lines, "drafts_small_edits"), [
    "drafts_small_edits: 1.000 approved=2 unedited=1 small_edits=1 target=0.5",
  ]);
});

test("active_day, active_streak and active_workspaces: 20 qualifying working days with weekends between give 20; a day with 2 sender accounts breaks the run; a reply naming no step is no send; an idle week counts no workspace", async () => {
  const workingDays = daysFrom("2026-02-02", "2026-02-27").filter(isWeekday);
  assert.equal(workingDays.length, 20);
  const seed = async (fx: ReportFixture, slug: string, thinDay: string | null) => {
    const [one, two] = [await fx.enrolledLead(`${slug}-1`), await fx.enrolledLead(`${slug}-2`)];
    // The second lead's steps are another campaign's: one agent has one campaign.
    await app.stepExecution.updateMany({
      where: { enrollmentId: two.enrollmentId },
      data: { templateId: `cmp_${slug}` },
    });
    const senders = [accountId(), accountId(), accountId()] as const;
    for (const day of workingDays) {
      const at = new Date(`${day}T10:00:00Z`);
      await fx.logSend({ accountId: senders[0], stepExecutionId: one.steps.connect, at });
      await fx.logSend({ accountId: senders[1], stepExecutionId: two.steps.connect, at });
      if (day !== thinDay) {
        await fx.logSend({ accountId: senders[2], stepExecutionId: one.steps.connect, at });
      }
    }
    // An Inbox reply's row names no step: no sender of its own counts (the task's note).
    const reply = new Date("2026-02-02T11:00:00Z");
    await fx.logSend({ accountId: accountId(), stepExecutionId: null, at: reply, kind: "message" });
  };
  await A.account();
  await B.account();
  await seed(A, "gamma-active-a", null);
  await seed(B, "gamma-active-b", "2026-02-16");

  const { lines } = await report(NOW, "--since", "2026-02-01");
  const ours = linesOf(lines, "active_day").filter((line) => line.includes(A.workspaceId));
  assert.equal(ours.length, 23, "every weekday from the first send to the run's day");
  assert.equal(ours[0], `active_day: ${A.workspaceId} 2026-02-02 campaigns=2 senders=3`);
  assert.equal(ours.at(-1), `active_day: ${A.workspaceId} 2026-03-04 campaigns=0 senders=0`);
  assert.ok(!ours.some((line) => / 2026-02-0[78] /.test(line)), "no weekend day");
  assert.ok(
    linesOf(lines, "active_day").includes(
      `active_day: ${B.workspaceId} 2026-02-16 campaigns=2 senders=2`,
    ),
  );
  // The workspaces in tenancy's order, by id: A's, then B's.
  assert.deepEqual(linesOf(lines, "active_streak"), [
    `active_streak: ${A.workspaceId} 20 target=20`,
    `active_streak: ${B.workspaceId} 10 target=20`,
  ]);
  assert.deepEqual(linesOf(lines, "active_workspaces"), [
    "active_workspaces: 2026-W06 2",
    "active_workspaces: 2026-W07 2",
    "active_workspaces: 2026-W08 2",
    "active_workspaces: 2026-W09 2",
    "active_workspaces: 2026-W10 0",
  ]);
  // gamma's lines follow beta's, in the task's order.
  const codes = [...new Set(lines.map((line) => line.split(":")[0]))];
  const decisionDays = codes.indexOf("decision_days");
  assert.deepEqual(codes.slice(decisionDays), [
    "decision_days",
    "restrictions_per_100",
    "review_approval",
    "unedited_approvals",
    "active_day",
    "active_streak",
    "active_workspaces",
  ]);
});

test("the ratios: per 100 accounts, the review share and the unedited share, none when nothing was counted", () => {
  assert.equal(per100({ restricted: 1, active: 40 }), 2.5);
  assert.equal(per100({ restricted: 2, active: 100 }), 2);
  assert.equal(per100({ restricted: 1, active: 0 }), null);
  assert.equal(reviewShare({ approved: 3, rejected: 2 }), 0.6);
  assert.equal(reviewShare({ approved: 0, rejected: 0 }), null);
  assert.equal(uneditedShare({ approved: 4, unedited: 2, smallEdits: 1 }), 0.5);
  assert.equal(uneditedShare({ approved: 0, unedited: 0, smallEdits: 0 }), null);
});

test("the days: a month, an ISO week across the year's turn, and every day between two", () => {
  assert.equal(monthOf("2026-02-28"), "2026-02");
  assert.equal(isoWeekOf("2026-01-01"), "2026-W01");
  assert.equal(isoWeekOf("2025-12-29"), "2026-W01");
  assert.equal(isoWeekOf("2025-12-28"), "2025-W52");
  assert.equal(isoWeekOf("2027-01-01"), "2026-W53");
  assert.equal(isoWeekOf("2026-03-04"), "2026-W10");
  assert.deepEqual(daysFrom("2026-02-27", "2026-03-02"), [
    "2026-02-27",
    "2026-02-28",
    "2026-03-01",
    "2026-03-02",
  ]);
  assert.deepEqual(daysFrom("2026-03-02", "2026-03-01"), []);
});

test("the streak, pure: weekends no break, a thin day a break, campaigns and senders both needed; the weeks with or without a send", () => {
  const sends = (day: string, campaigns: number, senders: number): ActiveSend[] =>
    Array.from({ length: Math.max(campaigns, senders) }, (_, n) => ({
      day,
      campaign: n < campaigns ? `cmp_${n}` : null,
      senderAccountId: `sac_${Math.min(n, senders - 1)}`,
    }));
  const weekdays = daysFrom("2026-02-02", "2026-02-27").filter(isWeekday);
  const full = weekdays.flatMap((day) => sends(day, 2, 3));
  assert.equal(longestStreak(activeDays(full, "2026-02-27"), MIN), 20);
  const thin = weekdays.flatMap((day) => sends(day, 2, day === "2026-02-11" ? 2 : 3));
  assert.equal(longestStreak(activeDays(thin, "2026-02-27"), MIN), 12);
  const oneAgent = weekdays.flatMap((day) => sends(day, day === "2026-02-25" ? 1 : 2, 3));
  assert.equal(longestStreak(activeDays(oneAgent, "2026-02-27"), MIN), 17);
  assert.equal(longestStreak(activeDays([], "2026-02-27"), MIN), 0);
  assert.deepEqual(activeWeeks(sends("2026-02-07", 1, 1), "2026-02-18"), [
    { week: "2026-W06", active: true },
    { week: "2026-W07", active: false },
    { week: "2026-W08", active: false },
  ]);
});

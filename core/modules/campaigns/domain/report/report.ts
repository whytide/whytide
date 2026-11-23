// A workspace's "Done when" figures (README.md "Commands"), each read in the caller's tenant run, in
// the order the command prints them. Nothing is written and no provider is called; what is kept is
// ids, codes, counts, days and instants, never a name, a text, a note or a provider reference.
// gamma-p7-050 adds the erased persons' sends, the restrictions per month, the review and edit
// shares' counts, and the activity by working day and ISO week, LinkedIn's (its email part waits).
import type { EditStats } from "@whytide/approvals";
import type { HealthEventRow, SendLogRow } from "@whytide/linkedin";
import { currentTenant } from "@whytide/platform";
import { acceptanceBySender, type SenderAcceptance } from "./acceptance.ts";
import { type ActiveDay, activeDays, activeSends } from "./activity.ts";
import { sendsWithoutApproval, type Violation } from "./approval.ts";
import { utcDay } from "./days.ts";
import { type DecidedWeekdays, decidedWeekdays } from "./decisions.ts";
import { type Duplicate, duplicateSends } from "./duplicates.ts";
import { editCounts } from "./edits.ts";
import { warnings } from "./health.ts";
import { type MonthRestrictions, monthlyRestrictions } from "./restrictions.ts";
import { type ReviewCounts, reviewCounts } from "./reviews.ts";
import { readSends } from "./sends.ts";
import { type SenderSpan, senderSpans } from "./span.ts";
import { actionsAgainstSuppressed, type ErasedSend } from "./suppressed.ts";
import { type ActiveWeek, activeWeeks } from "./weeks.ts";

/** What the figures read: the period and the run's instant, with the two windows set from it. */
export type ReportPeriod = {
  /** The period's first instant: --since's UTC midnight, or the epoch for every row. */
  readonly since: Date;
  /** The run's instant. */
  readonly now: Date;
  /** The latest send the acceptance rate counts: younger invites are left out. */
  readonly sentBefore: Date;
  /** The local days before the run's day that decision_days covers. */
  readonly decisionWindowDays: number;
  /** The days before the run that review_approval covers. */
  readonly reviewWindowDays: number;
};

export type WorkspaceReport = {
  readonly workspaceId: string;
  readonly withoutApproval: readonly Violation[];
  readonly missing: readonly SendLogRow[];
  readonly suppressed: readonly Violation[];
  readonly erased: readonly ErasedSend[];
  readonly duplicates: readonly Duplicate[];
  readonly edits: EditStats;
  readonly acceptance: readonly SenderAcceptance[];
  readonly spans: readonly SenderSpan[];
  readonly warnings: readonly HealthEventRow[];
  readonly decisions: DecidedWeekdays;
  readonly restrictions: readonly MonthRestrictions[];
  readonly reviews: ReviewCounts;
  readonly activeDays: readonly ActiveDay[];
  readonly activeWeeks: readonly ActiveWeek[];
};

/** The run's workspace's figures (the file's header). */
export async function reportWorkspace(period: ReportPeriod): Promise<WorkspaceReport> {
  const { rows, sends, missing } = await readSends(period);
  const { suppressed, erased } = await actionsAgainstSuppressed(sends);
  const events = await warnings(period);
  const active = activeSends(sends, missing);
  const lastDay = utcDay(period.now);
  return {
    workspaceId: currentTenant().workspaceId,
    withoutApproval: await sendsWithoutApproval(sends),
    missing,
    suppressed,
    erased,
    duplicates: await duplicateSends(period),
    edits: await editCounts(period),
    acceptance: await acceptanceBySender(period),
    spans: senderSpans(rows),
    warnings: events,
    decisions: await decidedWeekdays({ now: period.now, days: period.decisionWindowDays }),
    restrictions: monthlyRestrictions(active, events, lastDay),
    reviews: await reviewCounts({ now: period.now, days: period.reviewWindowDays }),
    activeDays: activeDays(active, lastDay),
    activeWeeks: activeWeeks(active, lastDay),
  };
}

// A workspace's "Done when" figures (README.md "Commands"), each read in the caller's tenant run, in
// the order the command prints them. Nothing is written and no provider is called; what is kept is
// ids, codes, counts, days and instants, never a name, a text, a note or a provider reference.
import type { EditStats } from "@whytide/approvals";
import type { HealthEventRow, SendLogRow } from "@whytide/linkedin";
import { currentTenant } from "@whytide/platform";
import { acceptanceBySender, type SenderAcceptance } from "./acceptance.ts";
import { sendsWithoutApproval, type Violation } from "./approval.ts";
import { type DecidedWeekdays, decidedWeekdays } from "./decisions.ts";
import { type Duplicate, duplicateSends } from "./duplicates.ts";
import { editCounts } from "./edits.ts";
import { warnings } from "./health.ts";
import { readSends } from "./sends.ts";
import { type SenderSpan, senderSpans } from "./span.ts";
import { actionsAgainstSuppressed } from "./suppressed.ts";

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
};

export type WorkspaceReport = {
  readonly workspaceId: string;
  readonly withoutApproval: readonly Violation[];
  readonly missing: readonly SendLogRow[];
  readonly suppressed: readonly Violation[];
  readonly duplicates: readonly Duplicate[];
  readonly edits: EditStats;
  readonly acceptance: readonly SenderAcceptance[];
  readonly spans: readonly SenderSpan[];
  readonly warnings: readonly HealthEventRow[];
  readonly decisions: DecidedWeekdays;
};

/** The run's workspace's figures (the file's header). */
export async function reportWorkspace(period: ReportPeriod): Promise<WorkspaceReport> {
  const { rows, sends, missing } = await readSends(period);
  return {
    workspaceId: currentTenant().workspaceId,
    withoutApproval: await sendsWithoutApproval(sends),
    missing,
    suppressed: await actionsAgainstSuppressed(sends),
    duplicates: await duplicateSends(period),
    edits: await editCounts(period),
    acceptance: await acceptanceBySender(period),
    spans: senderSpans(rows),
    warnings: await warnings(period),
    decisions: await decidedWeekdays({ now: period.now, days: period.decisionWindowDays }),
  };
}

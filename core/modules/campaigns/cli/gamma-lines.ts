// gamma's lines of the report (README.md "Commands"; gamma-p7-050, LinkedIn's part), pure, after
// beta's: the restrictions per 100 active accounts of each month, the review and edit shares, each
// workspace's working days and its longest streak, and the workspaces active each ISO week. The
// workspaces' counts are added, never read in one query across them; every line holds ids, codes,
// counts, days and instants only.
import { uneditedShare } from "../domain/report/edits.ts";
import type { WorkspaceReport } from "../domain/report/report.ts";
import { per100 } from "../domain/report/restrictions.ts";
import { reviewShare } from "../domain/report/reviews.ts";
import { longestStreak } from "../domain/report/streak.ts";
import {
  DONE_WHEN_MIN_AGENTS,
  DONE_WHEN_MIN_SENDERS,
  LINE,
  PERMANENT_BY_HAND,
  TARGETS,
} from "./constants.ts";
import { share } from "./format.ts";

/** gamma's lines of the reports, in the order of the workspaces given (the file's header). */
export function gammaLines(reports: readonly WorkspaceReport[]): string[] {
  return [
    ...restrictionLines(reports),
    ...shareLines(reports),
    ...activityLines(reports),
    ...weekLines(reports),
  ];
}

/** restrictions_per_100 per month, the workspaces' accounts added. */
function restrictionLines(reports: readonly WorkspaceReport[]): string[] {
  const months = new Map<string, { restricted: number; active: number }>();
  for (const { month, restricted, active } of reports.flatMap(({ restrictions }) => restrictions)) {
    const counts = months.get(month) ?? { restricted: 0, active: 0 };
    months.set(month, {
      restricted: counts.restricted + restricted,
      active: counts.active + active,
    });
  }
  return [...months]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, counts]) => {
      const counted = `restricted=${counts.restricted} active=${counts.active}`;
      const target = `target=${TARGETS.restrictionsPer100} ${PERMANENT_BY_HAND}`;
      return `${LINE.restrictionsPer100}: ${month} ${share(per100(counts))} ${counted} ${target}`;
    });
}

/** review_approval and unedited_approvals, the workspaces' counts added. */
function shareLines(reports: readonly WorkspaceReport[]): string[] {
  const reviews = { approved: 0, rejected: 0 };
  const edits = { approved: 0, unedited: 0, smallEdits: 0 };
  for (const report of reports) {
    reviews.approved += report.reviews.approved;
    reviews.rejected += report.reviews.rejected;
    edits.approved += report.edits.approved;
    edits.unedited += report.edits.unedited;
    edits.smallEdits += report.edits.smallEdits;
  }
  const decided = `approved=${reviews.approved} rejected=${reviews.rejected}`;
  const approved = `approved=${edits.approved} unedited=${edits.unedited}`;
  return [
    `${LINE.reviewApproval}: ${share(reviewShare(reviews))} ${decided} target=${TARGETS.reviewApproval}`,
    `${LINE.uneditedApprovals}: ${share(uneditedShare(edits))} ${approved} target=${TARGETS.uneditedApprovals}`,
  ];
}

/** Each workspace's active_day lines, then each one's active_streak. */
function activityLines(reports: readonly WorkspaceReport[]): string[] {
  const min = { campaigns: DONE_WHEN_MIN_AGENTS, senders: DONE_WHEN_MIN_SENDERS };
  const days = reports.flatMap(({ workspaceId, activeDays }) =>
    activeDays.map(
      ({ day, campaigns, senders }) =>
        `${LINE.activeDay}: ${workspaceId} ${day} campaigns=${campaigns} senders=${senders}`,
    ),
  );
  const streaks = reports.map(
    ({ workspaceId, activeDays }) =>
      `${LINE.activeStreak}: ${workspaceId} ${longestStreak(activeDays, min)} target=${TARGETS.streakDays}`,
  );
  return [...days, ...streaks];
}

/** active_workspaces per ISO week: the workspaces with at least one send in it. */
function weekLines(reports: readonly WorkspaceReport[]): string[] {
  const weeks = new Map<string, number>();
  for (const { week, active } of reports.flatMap(({ activeWeeks }) => activeWeeks)) {
    weeks.set(week, (weeks.get(week) ?? 0) + (active ? 1 : 0));
  }
  return [...weeks]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([week, count]) => `${LINE.activeWorkspaces}: ${week} ${count}`);
}

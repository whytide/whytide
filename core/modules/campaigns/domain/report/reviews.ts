// review_approval (README.md "Commands"; gamma's "Done when": at least 60% of the leads reviewed are
// approved), in the caller's tenant run: of contacts' latestReviews, each reviewed lead's latest
// decision, those made in the `days` days before the run, Good lead approving and Not a fit rejecting.
import { latestReviews } from "@whytide/contacts";
import { APPROVED_REVIEW, MS_PER_DAY, REJECTED_REVIEW } from "./constants.ts";

/** The leads approved and rejected in the window. */
export type ReviewCounts = { readonly approved: number; readonly rejected: number };

/** The window's counts (the file's header): decided after its start, at or before the run. */
export async function reviewCounts(window: {
  readonly now: Date;
  readonly days: number;
}): Promise<ReviewCounts> {
  const start = window.now.getTime() - window.days * MS_PER_DAY;
  const counts = { approved: 0, rejected: 0 };
  for (const { decision, decidedAt } of await latestReviews()) {
    const at = decidedAt.getTime();
    if (at <= start || at > window.now.getTime()) continue;
    if (decision === APPROVED_REVIEW) counts.approved += 1;
    if (decision === REJECTED_REVIEW) counts.rejected += 1;
  }
  return counts;
}

/** approved / (approved + rejected); null when none was decided. */
export const reviewShare = ({ approved, rejected }: ReviewCounts) =>
  approved + rejected === 0 ? null : approved / (approved + rejected);

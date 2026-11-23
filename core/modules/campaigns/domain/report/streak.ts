// active_streak (README.md "Commands"; gamma's "Done when": 2 agents and 3 senders active every working
// day for four weeks), pure: the longest run of working days in a row, a weekend between them no
// break, each with at least the campaigns and the sender accounts given. The days are activity.ts's
// activeDays: every weekday of the period, in order.
import type { ActiveDay } from "./activity.ts";

/** The longest run's length in working days; 0 when no day qualifies. */
export function longestStreak(
  days: readonly ActiveDay[],
  min: { readonly campaigns: number; readonly senders: number },
): number {
  let longest = 0;
  let run = 0;
  for (const { campaigns, senders } of days) {
    run = campaigns >= min.campaigns && senders >= min.senders ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

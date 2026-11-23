// The read budget's arithmetic (README.md "Runs"; gamma-p5-040, gamma-p5-045), pure: what one run may
// read of its account's day, and how much of it its pages may take. The share is fair, not exact:
// runs that start together may each see the same reads left, and linkedin's `keep`, checked under the
// day's lock, is the hard floor. The workflow's sandbox imports this file (pageLimitOf), so it reads
// no setting: the caller passes the reads kept, SIGNALS_READS_KEPT_FOR_SENDS.
import { PAGE_READS_MIN, PAGE_READS_SHARE } from "./constants.ts";

/**
 * The account's sources still due today as the share counts them, this run's included: its groups,
 * each agent with one and the sources in no agent, and the sources of this run's group.
 */
export type Groups = { readonly groups: number; readonly inGroup: number };

/**
 * A run's read budget: the account's reads left today less `kept` (SIGNALS_READS_KEPT_FOR_SENDS),
 * shared evenly by the groups, then by the sources of the run's group (1 of each at least), each
 * rounded down, never below 0. The budgets of all the due sources never add up to more than the reads
 * less those kept.
 */
export function shareOf(left: number, { groups, inGroup }: Groups, kept: number): number {
  const perGroup = Math.floor((left - kept) / Math.max(groups, 1));
  return Math.max(Math.floor(perGroup / Math.max(inGroup, 1)), 0);
}

/**
 * The page reads a run with `readBudget` may make, posts' and engagers' together: PAGE_READS_SHARE of
 * its budget, rounded down, never below PAGE_READS_MIN; its profiles read with the rest.
 */
export function pageLimitOf(readBudget: number): number {
  return Math.max(Math.floor(readBudget * PAGE_READS_SHARE), PAGE_READS_MIN);
}

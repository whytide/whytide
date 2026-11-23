// restrictions_per_100 (README.md "Commands"; gamma's "Done when": at most 2 restrictions per 100
// active accounts a month), pure: for each calendar month (UTC) from the first with a send or a
// restriction to the run's, the sender accounts restricted in it (linkedin's healthEventsSince, into
// restricted) and those with at least one send in it (activity.ts). linkedin records no permanent
// restriction: the operator checks that by hand.
import type { HealthEventRow } from "@whytide/linkedin";
import { type ActiveSend, firstDay } from "./activity.ts";
import { PER_HUNDRED, RESTRICTED_STATE } from "./constants.ts";
import { daysFrom, monthOf, utcDay } from "./days.ts";

/** A month, `YYYY-MM`, its restricted accounts and its active accounts. */
export type MonthRestrictions = {
  readonly month: string;
  readonly restricted: number;
  readonly active: number;
};

/** Each month's accounts (the file's header); none without a send or a restriction. */
export function monthlyRestrictions(
  sends: readonly ActiveSend[],
  events: readonly HealthEventRow[],
  lastDay: string,
): MonthRestrictions[] {
  const restrictions = events
    .filter(({ toState }) => toState === RESTRICTED_STATE)
    .map(({ senderAccountId, createdAt }) => ({ day: utcDay(createdAt), senderAccountId }));
  const first = firstDay([...sends, ...restrictions]);
  if (first === null) return [];
  const accounts = (held: readonly { day: string; senderAccountId: string }[], month: string) =>
    new Set(held.filter(({ day }) => monthOf(day) === month).map(({ senderAccountId: id }) => id))
      .size;
  const months = [...new Set(daysFrom(first, lastDay).map(monthOf))];
  return months.map((month) => ({
    month,
    restricted: accounts(restrictions, month),
    active: accounts(sends, month),
  }));
}

/** restricted / active × 100; null when no account sent. */
export const per100 = ({ restricted, active }: { restricted: number; active: number }) =>
  active === 0 ? null : (restricted / active) * PER_HUNDRED;

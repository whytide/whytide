// Days as the report writes them (README.md "Commands"), pure: a `YYYY-MM-DD` label, the whole days
// between two labels, a label moved by days, and whether a label is a weekday, Monday to Friday.
import { MONDAY_TO_FRIDAY } from "@whytide/platform";
import { DAY_LENGTH, ISO_SUNDAY, MS_PER_DAY } from "./constants.ts";

/** The day's midnight in UTC, as a timestamp; NaN for a label that is no date. */
export const midnightOf = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** The instant's day in UTC. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, DAY_LENGTH);

/** The day `n` days after `day` (before it, for a negative `n`). */
export const addDays = (day: string, n: number): string =>
  new Date(midnightOf(day) + n * MS_PER_DAY).toISOString().slice(0, DAY_LENGTH);

/** The whole days from `first` to `last`. */
export const daysBetween = (first: string, last: string): number =>
  Math.round((midnightOf(last) - midnightOf(first)) / MS_PER_DAY);

/** Whether the day is Monday to Friday. */
export function isWeekday(day: string): boolean {
  const isoDay = new Date(midnightOf(day)).getUTCDay() || ISO_SUNDAY;
  return (MONDAY_TO_FRIDAY as readonly number[]).includes(isoDay);
}

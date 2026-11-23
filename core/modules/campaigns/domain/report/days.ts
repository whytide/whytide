// Days as the report writes them (README.md "Commands"), pure: a `YYYY-MM-DD` label, the whole days
// between two labels, a label moved by days, and whether a label is a weekday, Monday to Friday;
// gamma-p7-050: the days between two labels, a day's month and its ISO week.
import { MONDAY_TO_FRIDAY } from "@whytide/platform";
import {
  DAY_LENGTH,
  DAYS_PER_WEEK,
  FIRST_OF_YEAR,
  ISO_SUNDAY,
  ISO_THURSDAY,
  MONTH_LENGTH,
  MS_PER_DAY,
  WEEK_DIGITS,
  YEAR_LENGTH,
} from "./constants.ts";

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

/** Every day from `first` to `last`, both included; none when `last` is before `first`. */
export const daysFrom = (first: string, last: string): string[] =>
  Array.from({ length: Math.max(0, daysBetween(first, last) + 1) }, (_, n) => addDays(first, n));

/** The day's month, `YYYY-MM`. */
export const monthOf = (day: string): string => day.slice(0, MONTH_LENGTH);

/** The day's ISO week, `YYYY-Www`: the week of its Thursday, numbered in its Thursday's year. */
export function isoWeekOf(day: string): string {
  const isoDay = new Date(midnightOf(day)).getUTCDay() || ISO_SUNDAY;
  const thursday = addDays(day, ISO_THURSDAY - isoDay);
  const year = thursday.slice(0, YEAR_LENGTH);
  const week = Math.floor(daysBetween(`${year}${FIRST_OF_YEAR}`, thursday) / DAYS_PER_WEEK) + 1;
  return `${year}-W${String(week).padStart(WEEK_DIGITS, "0")}`;
}

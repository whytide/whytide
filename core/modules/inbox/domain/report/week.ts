// The ISO week of an instant in UTC (README.md "The report"), pure: `2026-W44`, the week of its
// Thursday's year, as the reply golden set's weekRange reads a week.
import { DAY_MS, DAYS_PER_WEEK, THURSDAY_OFFSET_DAYS } from "../export/constants.ts";
import { WEEK_DIGITS } from "./constants.ts";

/** The instant's ISO week, `YYYY-Www`, in UTC. */
export function isoWeek(at: Date): string {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  // getUTCDay counts from Sunday: the days since Monday.
  const sinceMonday = (at.getUTCDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK;
  const thursday = new Date(day + (THURSDAY_OFFSET_DAYS - sinceMonday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const number =
    Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / DAYS_PER_WEEK) + 1;
  return `${year}-W${String(number).padStart(WEEK_DIGITS, "0")}`;
}

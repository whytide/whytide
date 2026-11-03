// The reply golden set's week (README.md "The reply golden set"), pure: an ISO week, `2026-W44`, in
// UTC, from its Monday at 00:00 to the next. One its year does not have, a malformed one, or one that
// has not started is week_invalid: the route answers it 400 and the command exits 2.
import { AppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import {
  DAY_MS,
  DAYS_PER_WEEK,
  ISO_WEEK,
  THURSDAY_OFFSET_DAYS,
  WEEK_ONE_DAY,
} from "./constants.ts";

/** A week's instants: `start` in it, `end` the next week's start. */
export type WeekRange = { readonly start: Date; readonly end: Date };

/** The week's instants; week_invalid unless it is an ISO week of its year that started by `now`. */
export function weekRange(week: string, now: Date): WeekRange {
  const match = ISO_WEEK.exec(week);
  if (match === null) throw new AppError(errors.week_invalid);
  const [year, number] = [Number(match[1]), Number(match[2])];
  const weekOne = Date.UTC(year, 0, WEEK_ONE_DAY);
  // getUTCDay counts from Sunday: the days since Monday.
  const sinceMonday = (new Date(weekOne).getUTCDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK;
  const start = weekOne + (-sinceMonday + (number - 1) * DAYS_PER_WEEK) * DAY_MS;
  const thursday = new Date(start + THURSDAY_OFFSET_DAYS * DAY_MS);
  if (number < 1 || thursday.getUTCFullYear() !== year || start > now.getTime()) {
    throw new AppError(errors.week_invalid);
  }
  return { start: new Date(start), end: new Date(start + DAYS_PER_WEEK * DAY_MS) };
}

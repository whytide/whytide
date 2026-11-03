// Business days (README "Time"; briefs RB-9.2.2), pure: the instant some business days after
// another, at the same local clock time, counting only the ISO weekdays given. Every beta caller
// passes MONDAY_TO_FRIDAY in the sender's zone; holidays are not counted.
import { DAY_MS, ISO_WEEKDAYS } from "./constants.ts";
import { timeArgumentInvalid } from "./errors.ts";
import { instantOfWall, isoDayAt, wallAt } from "./zone.ts";

/**
 * The instant `n` business days after `at`, at the same local clock time, to the millisecond. Each
 * step moves to the next day whose ISO weekday is in `days`, so 1 from a Saturday is the Monday;
 * `n = 0` answers `at`. On a day whose daylight-saving change skips that clock time, the instant
 * lands an hour later.
 */
export function addBusinessDays(
  at: Date,
  n: number,
  timeZone: string,
  days: readonly number[],
): Date {
  if (!Number.isSafeInteger(n) || n < 0) throw timeArgumentInvalid("n");
  const weekdays: readonly number[] = ISO_WEEKDAYS.filter((day) => days.includes(day));
  if (weekdays.length === 0) throw timeArgumentInvalid("days");
  if (n === 0) return new Date(at);
  const wall = wallAt(at.getTime(), timeZone);
  const clock = ((wall % DAY_MS) + DAY_MS) % DAY_MS;
  const next = (day: number): number => {
    let after = day + DAY_MS;
    while (!weekdays.includes(isoDayAt(after))) after += DAY_MS;
    return after;
  };
  // The first step, then whole weeks, each of which holds every weekday of `days` once, then the
  // rest one by one: the same as n steps, without n loops.
  let day = next(wall - clock);
  day += ISO_WEEKDAYS.length * DAY_MS * Math.floor((n - 1) / weekdays.length);
  for (let left = (n - 1) % weekdays.length; left > 0; left--) day = next(day);
  return new Date(instantOfWall(day + clock, timeZone));
}

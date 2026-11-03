// The quota day and the working-hours window (README "Time"), moved from linkedin's
// domain/quota/window.ts with its behavior, pure: an instant, an IANA zone and local hours in, a
// date or an instant out. linkedin keeps its copy until beta-p1-020 switches to these. A local time
// that a spring-forward skips lands an hour later, on both sides of UTC; one that a fall-back
// repeats is the earlier of its two instants.
import { ISO_WEEKDAYS, MIDNIGHT } from "./constants.ts";
import { timeArgumentInvalid } from "./errors.ts";
import type { LocalSchedule } from "./time.ts";
import { addDays, instantOfWall, isoDayOf, localAt } from "./zone.ts";

/** A local schedule's `start`, `end` and `days`, without its zone: linkedin's WorkingHours fits. */
export type LocalHours = {
  readonly start: LocalSchedule["start"];
  readonly end: LocalSchedule["end"];
  readonly days: Readonly<LocalSchedule["days"]>;
};

/** The quota day of the instant: its date in the zone, `YYYY-MM-DD` (data model §2.3). */
export const quotaDay = (at: Date, timeZone: string): string => localAt(at, timeZone).date;

/** The start of the next quota day: the next local midnight. */
export function nextQuotaDayAt(at: Date, timeZone: string): Date {
  return instantAt(addDays(quotaDay(at, timeZone), 1), MIDNIGHT, timeZone);
}

/** Open on a working day from `start` until before `end`, local times. */
export function isWindowOpen(at: Date, timeZone: string, hours: LocalHours): boolean {
  const { time, isoDay } = localAt(at, timeZone);
  return hours.days.includes(isoDay) && hours.start <= time && time < hours.end;
}

/** The first window start after the instant: today's `start`, or a later working day's. */
export function nextWindowAt(at: Date, timeZone: string, hours: LocalHours): Date {
  const today = quotaDay(at, timeZone);
  for (let ahead = 0; ahead <= ISO_WEEKDAYS.length; ahead++) {
    const date = addDays(today, ahead);
    if (!hours.days.includes(isoDayOf(date))) continue;
    const start = instantAt(date, hours.start, timeZone);
    if (start > at) return start;
  }
  throw timeArgumentInvalid("days"); // no ISO weekday; localSchedule refuses such days
}

/** The instant of a local date `YYYY-MM-DD` and time `HH:mm` in the zone. */
export function instantAt(date: string, time: string, timeZone: string): Date {
  return new Date(instantOfWall(Date.parse(`${date}T${time}:00Z`), timeZone));
}

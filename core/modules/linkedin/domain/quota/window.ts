// The quota day and the working-hours window of an account (docs/concepts.md), pure: an instant, the
// account's IANA zone and its hours in, a date or an instant out. Local times come from Intl, so the
// offsets and their daylight-saving changes are the runtime's time-zone data, never a table here. A
// local time that a spring-forward skips lands an hour later.
import type { WorkingHours } from "../working-hours.ts";

type Local = { readonly date: string; readonly time: string; readonly isoDay: number };
/** What formatToParts gives for the format below, always. */
type Parts = Readonly<Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>>;

const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

/** The quota day of the instant: its date in the zone, `YYYY-MM-DD` (briefs RB-1.3.7). */
export const quotaDay = (at: Date, timeZone: string): string => localAt(at, timeZone).date;

/** The start of the next quota day: the next local midnight. */
export function nextQuotaDayAt(at: Date, timeZone: string): Date {
  return instantAt(addDays(quotaDay(at, timeZone), 1), "00:00", timeZone);
}

/** Open on a working day from `start` until before `end`, local times. */
export function isWindowOpen(at: Date, timeZone: string, hours: WorkingHours): boolean {
  const { time, isoDay } = localAt(at, timeZone);
  return hours.days.includes(isoDay) && hours.start <= time && time < hours.end;
}

/** The first window start after the instant: today's `start`, or a later working day's. */
export function nextWindowAt(at: Date, timeZone: string, hours: WorkingHours): Date {
  const today = quotaDay(at, timeZone);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const date = addDays(today, ahead);
    if (!hours.days.includes(isoDayOf(date))) continue;
    const start = instantAt(date, hours.start, timeZone);
    if (start > at) return start;
  }
  throw new Error("working hours without a day"); // parseWorkingHours refuses them
}

/** The instant of a local date and time in the zone: the UTC reading moved by the zone's offset, read again past a change. */
export function instantAt(date: string, time: string, timeZone: string): Date {
  const reading = Date.parse(`${date}T${time}:00Z`);
  const first = reading - offsetAt(reading, timeZone);
  return new Date(reading - offsetAt(first, timeZone));
}

function localAt(at: Date, timeZone: string): Local {
  const part = partsAt(at.getTime(), timeZone);
  const date = `${part.year}-${part.month}-${part.day}`;
  return { date, time: `${part.hour}:${part.minute}`, isoDay: isoDayOf(date) };
}

/** The zone's offset from UTC at the instant, in milliseconds. */
function offsetAt(at: number, timeZone: string): number {
  const part = partsAt(at, timeZone);
  const local = Date.UTC(
    +part.year,
    +part.month - 1,
    +part.day,
    +part.hour,
    +part.minute,
    +part.second,
  );
  return local - Math.floor(at / 1000) * 1000;
}

function partsAt(at: number, timeZone: string): Parts {
  let format = formats.get(timeZone);
  if (format === undefined) {
    const digits = "2-digit" as const;
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: digits,
      day: digits,
      hour: digits,
      minute: digits,
      second: digits,
    });
    formats.set(timeZone, format);
  }
  return Object.fromEntries(
    format.formatToParts(at).map(({ type, value }) => [type, value]),
  ) as Parts;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 1 for Monday to 7 for Sunday. */
function isoDayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
}

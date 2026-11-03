// A time zone's clock, read with Intl (README "Time"), for window.ts and business-days.ts; not
// exported from the package. The offsets and their daylight-saving changes are the runtime's
// time-zone data, never a table here. A wall reading is a local date and time written as a UTC
// timestamp: what Date.UTC gives for the local fields.
import { CLOCK_LOCALE, DATE_LENGTH, DAY_MS, ISO_SUNDAY, SECOND_MS } from "./constants.ts";

/** An instant's local reading: its date `YYYY-MM-DD`, its time `HH:mm` and its ISO weekday. */
export type Local = { readonly date: string; readonly time: string; readonly isoDay: number };
/** What formatToParts gives for the format below, always. */
type Parts = Readonly<Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>>;

const formats = new Map<string, Intl.DateTimeFormat>();

export function localAt(at: Date, timeZone: string): Local {
  const part = partsAt(at.getTime(), timeZone);
  const date = `${part.year}-${part.month}-${part.day}`;
  return { date, time: `${part.hour}:${part.minute}`, isoDay: isoDayOf(date) };
}

/** The wall reading of the instant in the zone, to the millisecond. */
export const wallAt = (at: number, timeZone: string): number => at + offsetAt(at, timeZone);

/**
 * The instant whose local clock shows the wall reading. A reading that a change skips has none:
 * the offset before the change places it later by the change's length, an hour. A reading that a
 * change repeats has two: the earlier, under the offset before the change. Each candidate lies
 * within a day of the reading, so the offsets a day either side are those before and after it.
 */
export function instantOfWall(wall: number, timeZone: string): number {
  const before = offsetAt(wall - DAY_MS, timeZone);
  const after = offsetAt(wall + DAY_MS, timeZone);
  if (offsetAt(wall - before, timeZone) === before) return wall - before;
  if (offsetAt(wall - after, timeZone) === after) return wall - after;
  return wall - before;
}

export function addDays(date: string, days: number): string {
  const day = new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
  return day.toISOString().slice(0, DATE_LENGTH);
}

/** The ISO weekday of a `YYYY-MM-DD` date, 1 for Monday to 7 for Sunday. */
export const isoDayOf = (date: string): number => isoDayAt(Date.parse(`${date}T00:00:00Z`));

/** The ISO weekday of the date of a UTC timestamp. */
export const isoDayAt = (at: number): number => new Date(at).getUTCDay() || ISO_SUNDAY;

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
  return local - Math.floor(at / SECOND_MS) * SECOND_MS;
}

function partsAt(at: number, timeZone: string): Parts {
  let format = formats.get(timeZone);
  if (format === undefined) {
    const digits = "2-digit" as const;
    format = new Intl.DateTimeFormat(CLOCK_LOCALE, {
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

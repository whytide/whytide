// Time (requirements, data model §2.3; coding §5): an instant is a Date, in UTC; a local schedule is
// an IANA time zone with local clock times and ISO weekdays, 1 (Monday) to 7 (Sunday).
import { z } from "zod";

const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const IANA = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

export function isTimeZone(value: string): boolean {
  if (!IANA.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A Date, or an ISO 8601 string with an offset or Z, parsed to a Date. */
export const instant = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((text) => new Date(text)),
]);

export const localSchedule = z
  .object({
    timeZone: z.string().refine(isTimeZone, "an IANA time zone"),
    start: z.string().regex(HHMM, "HH:mm"),
    end: z.string().regex(HHMM, "HH:mm"),
    days: z
      .array(z.int().min(1).max(7))
      .min(1)
      .refine((days) => new Set(days).size === days.length, "distinct weekdays"),
  })
  .refine((s) => !HHMM.test(s.start) || !HHMM.test(s.end) || s.start < s.end, {
    message: "start before end",
    path: ["end"],
  });
export type LocalSchedule = z.infer<typeof localSchedule>;

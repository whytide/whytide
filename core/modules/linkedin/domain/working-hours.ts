// Working hours (docs/concepts.md): an IANA zone and local times, `{ start: "08:30", end: "18:00",
// days: [1, 2, 3, 4, 5] }`, ISO days with 1 for Monday. Pure rules; a value off them is
// working_hours_invalid naming the fields at fault.
import { AppError } from "@whytide/platform";
import { errors } from "../errors.ts";

export type WorkingHours = {
  readonly start: string;
  readonly end: string;
  readonly days: readonly number[];
};

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  start: "09:00",
  end: "18:00",
  days: [1, 2, 3, 4, 5],
};
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The hours as given when they hold: times `HH:MM`, start before end, days distinct, 1 to 7, one at least. */
export function parseWorkingHours(value: {
  readonly start: string;
  readonly end: string;
  readonly days: readonly number[];
}): WorkingHours {
  const fields: string[] = [];
  const start = TIME.test(value.start) ? value.start : undefined;
  const end = TIME.test(value.end) ? value.end : undefined;
  if (start === undefined) fields.push("workingHours.start");
  if (end === undefined) fields.push("workingHours.end");
  // Equal-width "HH:MM" strings compare as the times they write.
  if (start !== undefined && end !== undefined && start >= end) fields.push("workingHours.end");
  const days = [...value.days];
  const dayOk = (day: number) => Number.isInteger(day) && day >= 1 && day <= 7;
  if (days.length === 0 || !days.every(dayOk) || new Set(days).size !== days.length) {
    fields.push("workingHours.days");
  }
  if (fields.length > 0) throw new AppError(errors.working_hours_invalid, { details: { fields } });
  return { start: value.start, end: value.end, days: days.toSorted((a, b) => a - b) };
}

/** The zone as given when Intl knows it (`Europe/Paris`), else working_hours_invalid naming `timeZone`. */
export function parseTimeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    throw new AppError(errors.working_hours_invalid, { details: { fields: ["timeZone"] } });
  }
}

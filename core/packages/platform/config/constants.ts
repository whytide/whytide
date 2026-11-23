// The constants of time (README "Time"): the business days every beta caller passes, the
// calendar's fixed numbers the helpers count with, then the recipient's business hours, how a
// location's region is read (recipient-hours.ts) and how far nextSpacedTime looks (random-times.ts).
import type { LocalHours } from "./window.ts";

/** Business days for every beta caller, in the sender's time zone: Monday to Friday, ISO weekdays. */
export const MONDAY_TO_FRIDAY = Object.freeze([1, 2, 3, 4, 5] as const);

/** The ISO weekdays, 1 (Monday) to 7 (Sunday). */
export const ISO_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7] as const);

/** Sunday, which JavaScript's getUTCDay numbers 0, is 7 in ISO. */
export const ISO_SUNDAY = 7;

/** A calendar day in milliseconds: dates step by it in UTC, where every day has 24 hours. */
export const DAY_MS = 86_400_000;

/** A second in milliseconds: the finest unit a zone's offset is read in. */
export const SECOND_MS = 1000;

/** The local time a quota day starts at. */
export const MIDNIGHT = "00:00";

/** `YYYY-MM-DD`, the head of an ISO 8601 timestamp. */
export const DATE_LENGTH = 10;

/** The locale a zone's clock is read in: its numeric parts only, never shown to anyone. */
export const CLOCK_LOCALE = "en-US";

/**
 * The recipient's business hours (F11 §5.1; briefs RB-12.2.1): Monday to Friday, 08:30 to 18:00,
 * in the recipient's time zone. Weekends opt-in and holidays come later.
 */
export const RECIPIENT_BUSINESS_HOURS: LocalHours = Object.freeze({
  start: "08:30",
  end: "18:00",
  days: MONDAY_TO_FRIDAY,
});

/** What separates a location's parts: "San Francisco, California, United States". */
export const LOCATION_PART_SEPARATOR = ",";

/**
 * How a place's name is compared, in order, once its accents are split off and its case dropped:
 * accents, dots and apostrophes go, "&" reads "and", any other run of signs is one space. So
 * "Québec", "N.S.W." and "Newfoundland & Labrador" find their regions.
 */
export const PLACE_NAME_STEPS: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/[\p{M}.'’]/gu, ""],
  [/&/g, " and "],
  [/[^a-z0-9]+/g, " "],
]);

/**
 * The windows nextSpacedTime tries after a draw falls outside one: a daylight-saving change can
 * empty a window or close it early, once a season, never eight windows in a row.
 */
export const SPACED_WINDOW_TRIES = 8;

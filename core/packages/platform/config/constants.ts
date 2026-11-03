// The constants of time (README "Time"): the business days every beta caller passes, and the
// calendar's fixed numbers the helpers count with.

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

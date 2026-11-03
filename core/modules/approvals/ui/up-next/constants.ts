// "Up next"'s tunable values, beside the code that reads them (docs/rules/coding.md "constants").

/** How often the queue is read again while a row's draft is being written. */
export const POLL_MS = 5_000;
/**
 * How long a row may be drafting, from its opening, before the screen stops asking: 20 minutes, where
 * messaging's draft panel stops too; "Check again" reads the queue once more.
 */
export const POLL_MAX_MS = 1_200_000;
export const MS_PER_MINUTE = 60_000;

/** The shimmering lines of each row the loading state draws (not in the sources). */
export const LOADING_LINES = [4, 4, 3] as const;

/** How long a toast says that a step was approved or skipped. */
export const TOAST_MS = 2_000;

/** A row's due time, in its sender's zone, named so that a reader knows which zone it is. */
export const TIME_FORMAT = {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
} as const;

/** A group's heading: the local day and hour its rows are due, in their sender's zone. */
export const GROUP_FORMAT = {
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  timeZoneName: "short",
} as const;

/** A dossier fact that is a date, shown as a day. */
export const FACT_DATE_FORMAT = { dateStyle: "medium" } as const;

// The values the enrollment route answers with (README.md "Routes"), beside its query
// (enrollments.ts): how many of a person's enrollments it reads, and the values of campaigns.prisma's
// enums, which schemas/enrollments.ts documents and the panel words (ui/enrollment-panel/). Then the
// acceptance's (acceptance.ts): the statuses of a connection request that went out, the units its
// delays are given in, and how many window starts the first message's due time tries. Last, the
// counts' (counts.ts): the days of the recent period, where a local day starts, and the zone of an
// account linkedin no longer holds.

/** A person's enrollments the route answers, newest first: beta enrolls a person once, plus refused attempts. */
export const ENROLLMENTS_SHOWN = 20;
/** The longest person id the route takes, as the other modules' routes take an id. */
export const ID_MAX = 64;

/** enrollment_status: `active`, then one of the others, never back (data model §5.2, reduced). */
export const ENROLLMENT_STATUSES = ["active", "replied", "completed", "exited"] as const;
/** enrollment_exit_reason: set exactly on an `exited` enrollment. */
export const EXIT_REASONS = [
  "suppressed",
  "removed",
  "no_sender",
  "not_accepted",
  "send_refused",
] as const;
/** step_execution_status: `planned` when written. */
export const STEP_STATUSES = [
  "planned",
  "awaiting_approval",
  "scheduled",
  "executing",
  "succeeded",
  "failed",
  "skipped",
  "held",
  "cancelled",
] as const;
/** step_action_type. */
export const ACTION_TYPES = ["invite", "message", "withdraw"] as const;

export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];
export type ExitReason = (typeof EXIT_REASONS)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * A connection request that went out: sent, or claimed by the sender, whose call may have reached
 * LinkedIn before it settles. Only such a step records an acceptance.
 */
export const WENT_OUT_STATUSES = ["succeeded", "executing"] as const;

/** The units the first message's delays, and the queue's window, are given in: minutes and hours. */
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * The window starts the first message's due time tries after its draw before it gives up: a week's
 * and one more. A daylight-saving change can skip one start with its whole window at most, as no zone
 * changes its clock on two weekdays running, so the second start tried is always open.
 */
export const WINDOW_STARTS_TRIED = 8;

/** The counts' recent period, in local days: today and the six days before it. */
export const RECENT_DAYS = 7;
/** The local clock time a day starts at, in the sender account's zone. */
export const LOCAL_DAY_START = "00:00";
/** A calendar day, to step a `YYYY-MM-DD` date back, and the length of such a date. */
export const MS_PER_DAY = 24 * MS_PER_HOUR;
export const DATE_LENGTH = 10;
/** The zone of a sender account linkedin no longer holds: its days are counted in UTC. */
export const COUNTS_FALLBACK_ZONE = "UTC";

// The values the enrollment route answers with (README.md "Routes"), beside its query
// (enrollments.ts): how many of a person's enrollments it reads, and the values of campaigns.prisma's
// enums, which schemas/enrollments.ts documents and the panel words (ui/enrollment-panel/). Then the
// acceptance's (acceptance.ts): the statuses of a connection request that went out, the units its
// delays are given in, and how many window starts the first message's due time tries. Then the
// counts' (counts.ts): the days of the recent period, where a local day starts, and the zone of an
// account linkedin no longer holds. Last, the funnel's (funnel.ts): the reply labels that are no
// reply, and the positive one.
import type { ReplyActionLabel } from "./replies/constants.ts";

/** A person's enrollments the route answers, newest first: beta enrolls a person once, plus refused attempts. */
export const ENROLLMENTS_SHOWN = 20;
/** The longest person id the route takes, as the other modules' routes take an id. */
export const ID_MAX = 64;

/**
 * enrollment_status: `active`, then one of the others, never back (data model §5.2, reduced), but
 * `paused`, which goes back to `active` (gamma-p3-060).
 */
export const ENROLLMENT_STATUSES = ["active", "replied", "completed", "exited", "paused"] as const;
/**
 * A live enrollment: active, or paused until it resumes. Every stop ends either, and the person has
 * one at most (the partial key enrollments_active_person).
 */
export const LIVE_ENROLLMENT_STATUSES = ["active", "paused"] as const;
/** What a stop writes beside an end: no pause, which the CHECK enrollments_paused refuses on it. */
export const NO_PAUSE = { pausedReason: null, pausedUntil: null } as const;
/** enrollment_pause_reason: a member's pause, or an out-of-office reply's (gamma-p4-050). */
export const ENROLLMENT_PAUSE_REASONS = ["user", "out_of_office"] as const;
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
/**
 * step_action_type's LinkedIn actions: what the queue, the plan and the sender work on, each of
 * their filters naming them, so an email step is passed over (gamma-p3-030).
 */
export const LINKEDIN_ACTIONS = ["invite", "message", "withdraw"] as const;
/** step_action_type: LinkedIn's actions, and email, which nothing sends until gamma-p4-010. */
export const ACTION_TYPES = [...LINKEDIN_ACTIONS, "email"] as const;

export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];
export type EnrollmentPauseReason = (typeof ENROLLMENT_PAUSE_REASONS)[number];
export type ExitReason = (typeof EXIT_REASONS)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type ActionType = (typeof ACTION_TYPES)[number];
export type LinkedInAction = (typeof LINKEDIN_ACTIONS)[number];

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

/**
 * The funnel's labels that are no reply (gamma-p4-050's REPLY_ACTION_LABELS): an out-of-office
 * answer, and a bounce, which says the address failed.
 */
export const NOT_REPLY_LABELS = [
  "out_of_office",
  "bounce",
] as const satisfies readonly ReplyActionLabel[];
/**
 * The funnel's positive reply: interested, which holds the brief's interested and referral labels
 * (gamma-p4-040); the latest label counts, so a member's correction does (analytics plan §2.1).
 */
export const POSITIVE_LABEL = "interested" satisfies ReplyActionLabel;

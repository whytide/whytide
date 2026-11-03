// The health numbers (README.md "Health"; C16): the cool-down of a restriction or a checkpoint, and
// the provider errors in an hour that pause the account until its next working day; the acceptance
// rule's (B.7); the fleet breaker's names; how the two mails write a time; the owner's resume's.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A restriction, LinkedIn's own limit or a checkpoint pauses every send and read of the account this
 * long at least (A.8); only the owner's resume lifts it (beta-p6-040).
 */
export const COOLDOWN_HOURS = 72;
export const COOLDOWN_MS = COOLDOWN_HOURS * HOUR_MS;

/**
 * The rate limits and provider errors (linkedin_rate_limited, linkedin_provider_error) of the account
 * within PROVIDER_ERROR_WINDOW_MINUTES, sends, checks and reads together: the one that reaches it
 * pauses the account's sends and reads until its next working day (the owner's decision of
 * 2026-10-29), with no cool-down.
 */
export const PROVIDER_ERRORS_PER_HOUR_MAX = 3;

/** The window the provider errors are counted in, back from the last one. */
export const PROVIDER_ERROR_WINDOW_MINUTES = 60;
export const PROVIDER_ERROR_WINDOW_MS = PROVIDER_ERROR_WINDOW_MINUTES * MINUTE_MS;

/**
 * The acceptance rule (acceptance.ts; RB-11.3.1, reduced): under ACCEPTANCE_MIN of the account's last
 * ACCEPTANCE_SAMPLE connection requests at least ACCEPTANCE_MIN_AGE_DAYS old accepted, its invites
 * pause (at_risk); at it or over, they resume; no rate while fewer are that old.
 */
export const ACCEPTANCE_MIN = 0.2;
export const ACCEPTANCE_SAMPLE = 100;
export const ACCEPTANCE_MIN_AGE_DAYS = 7;
export const ACCEPTANCE_MIN_AGE_MS = ACCEPTANCE_MIN_AGE_DAYS * DAY_MS;

/** How the owner's mail writes the end of a pause, in the account's zone. */
export const MAIL_DATE_FORMAT: Intl.DateTimeFormatOptions = Object.freeze({
  dateStyle: "full",
  timeStyle: "short",
});

/**
 * The fleet breaker's names (breaker.ts): the platform row's `changed_by` when it pauses invites,
 * the system's code, and its control event's `actor`.
 */
export const BREAKER_CHANGED_BY = "system";
export const BREAKER_ACTOR = "fleet_breaker";

/** How the operator's mail writes the warning's time: in UTC, the zone named. */
export const OPERATOR_MAIL_DATE_FORMAT: Intl.DateTimeFormatOptions = Object.freeze({
  dateStyle: "full",
  timeStyle: "long",
  timeZone: "UTC",
});

/** The owner's resume wants the worker's status read at most this old (resume.ts; not in the sources). */
export const RESUME_STATUS_MAX_AGE_MINUTES = 10;
export const RESUME_STATUS_MAX_AGE_MS = RESUME_STATUS_MAX_AGE_MINUTES * MINUTE_MS;

/** The account's latest health events the health view answers, newest first (not in the sources). */
export const HEALTH_EVENTS_SHOWN = 10;

/** Why the owner cannot resume, in the order asked (resume.ts); each the resume's error code. */
export const RESUME_REFUSALS = [
  "not_account_owner",
  "account_not_paused",
  "cooldown_active",
  "linkedin_account_disconnected",
  "reconnect_required",
  "status_check_required",
] as const;

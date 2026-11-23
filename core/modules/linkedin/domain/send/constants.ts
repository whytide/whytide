// The send reservations' numbers (docs/concepts.md "Send reservation"; README.md "Read
// quota"): the hold, the month's invitation notes, the pause after an unknown outcome, the
// days nothing is sent, and the bounds the error map and a key are read with.
import { COOLDOWN_MS } from "../health/constants.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A send reservation holds its slot this long (not in the sources): longer than the worst retry span
 * of a send activity, 5 attempts up to 15 minutes apart plus each attempt's timeout, so the slot is
 * still held when the last attempt settles it. The next reservation of its day frees it after.
 */
export const SEND_RESERVATION_MS = 2 * HOUR_MS;

/**
 * LINKEDIN_INVITE_NOTES_PER_MONTH's default (settings.ts, README.md "Settings"): the invitations with
 * a note an account sends at most in INVITE_NOTE_WINDOW_DAYS, LinkedIn's limit for a free account.
 */
export const INVITE_NOTES_PER_MONTH = { default: 3 } as const;

/** The days, back from now, the note budget counts. */
export const INVITE_NOTE_WINDOW_DAYS = 30;

/**
 * After an answer that leaves a send's outcome unknown (a provider error, an output off the port's
 * schema, an unmapped error), the account sends and reads nothing for this long (not in the sources):
 * retry_at, which beta-p1-050 sets.
 */
export const PROVIDER_ERROR_PAUSE_MS = HOUR_MS;

/** Saturday and Sunday, ISO days: nothing is sent on them in the account's zone, whatever its days. */
export const WEEKEND_DAYS: readonly number[] = Object.freeze([6, 7]);

/** The cool-down of a restriction or a checkpoint in the error map's account column (domain/health/). */
export const ACCOUNT_COOLDOWN_MS = COOLDOWN_MS;

/** A step's key at most: the LinkedIn port's bound on the key a send carries. */
export const SEND_KEY_MAX_CHARS = 128;

/** A second, for a rate limit's retryAfterSec. */
export const SECOND_MS = 1000;

/**
 * How long before the key's first reservation a message from the account still counts as the step's
 * (linkedin_check_sent, not in the sources): the provider's clock against ours. Earlier is the safe
 * side: a message counted as sent is never sent twice.
 */
export const SEND_CHECK_SKEW_MS = 5 * MINUTE_MS;

/**
 * The refusal reasons a send's answer names beside its code (SendFailed's `reason`): those the error
 * map keys a row of its own by, which campaigns settles otherwise than the code's. One: an invitation
 * to a person who is a connection already (connect-already-connected).
 */
export const SEND_REFUSED_REASONS = ["already_connected"] as const;
export type SendRefusedReason = (typeof SEND_REFUSED_REASONS)[number];

// The pending invitations' constants (README.md "Decided here"; docs/concepts.md "Pending
// invitations"), beside their readers: pending.ts, check.ts and send/state.ts.
import type { ActionOutcome } from "../../schemas/quota.ts";

/** No new invitation while more than this many are pending at the vendor (RB-11.2.5). */
export const PENDING_INVITES_MAX = 400;

/** A count older than this is unknown again: invites wait for the next day's check (not in the sources). */
export const PENDING_INVITES_FRESH_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;
export const PENDING_INVITES_FRESH_MS = PENDING_INVITES_FRESH_HOURS * HOUR_MS;

/**
 * The status refresh's period (workflows/index.ts' schedule): the day's check runs at the first hourly
 * run after check_after, so an invite refused pending_invites_unknown while that check is still to
 * come is retried this long after check_after, or after now once check_after has passed.
 */
export const PENDING_CHECK_RETRY_MS = HOUR_MS;

/**
 * A relation's port errors about its person alone, a profile deleted: the check closes that invite
 * and goes on, where any other error ends its pass (beta-p6-020).
 */
export const RELATION_GONE_CODES: readonly ActionOutcome[] = Object.freeze(["linkedin_not_found"]);

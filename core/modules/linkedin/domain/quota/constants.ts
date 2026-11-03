// The send quotas' numbers (docs/concepts.md "Budgets"; briefs RB-11.2.2): each account's targets
// start low and the ramp raises them (beta-p1-080), and every day's limit is drawn from its target,
// never above the hard maximum. The hard maximums live here and in linkedin_send_quotas' CHECKs only,
// never in config.ts or a setting, so no setting, route or script raises them (architecture §1, P5).
// Frozen, so nothing at run time changes them either.

/** Connection requests a day: the first target, the target the ramp stops at, the hard maximum. */
export const INVITES_PER_DAY = Object.freeze({ start: 5, target: 15, max: 25 } as const);

/** Messages a day: the first target, the target the ramp stops at, the hard maximum. */
export const MESSAGES_PER_DAY = Object.freeze({ start: 10, target: 40, max: 80 } as const);

/** Connection requests over the last WEEK_QUOTA_DAYS quota days: the cap, and the hard maximum of any cap. */
export const INVITES_PER_WEEK = Object.freeze({ cap: 100, max: 200 } as const);

/** The quota days the weekly cap counts: the day itself and the six before it. */
export const WEEK_QUOTA_DAYS = 7;

/** Every action of a day together: connection requests, messages, withdrawals and reads. */
export const ACTIONS_PER_DAY_MAX = 200;

/** Reads a day at most, whatever the account's cap; LINKEDIN_DAILY_READ_CAP_MAX's bound too. */
export const READS_PER_DAY_MAX = 100;

/** Withdrawals of pending connection requests a day at most (not in the sources). */
export const WITHDRAWALS_PER_DAY_MAX = 15;

/** Each day's limit is the target times a uniform draw from this share, rounded down. */
export const DAY_LIMIT_DRAW = Object.freeze({ min: 0.8, max: 1 } as const);

/** A read reservation holds its reads this long; the next reservation of its day frees it after.
 * A send's holds SEND_RESERVATION_MS (domain/send/constants.ts). */
export const RESERVATION_MS = 60 * 60_000;

/** A calendar day, which quota days step by in UTC, where every day has 24 hours. */
export const DAY_MS = 86_400_000;

/** `YYYY-MM-DD`, the head of an ISO 8601 timestamp: a quota day's length. */
export const DATE_LENGTH = 10;

/** Sunday, which JavaScript's getUTCDay numbers 0, is 7 in ISO, as working hours number it. */
export const ISO_SUNDAY = 7;

/**
 * The day's pending-invite check (domain/invites/check.ts) is drawn within CHECK_DRAW_MS of the start
 * of what is left of the window, never within CHECK_END_MARGIN_MS of its end, so that a weekday's
 * invites wait an hour or two at most and an hourly run comes after it inside the window
 * (decisions.md, 2026-10-30).
 */
export const CHECK_DRAW_MS = 2 * 60 * 60_000;
export const CHECK_END_MARGIN_MS = 60 * 60_000;

/** The local time a quota day starts at, as platform's nextQuotaDayAt has it. */
export const QUOTA_DAY_START = "00:00";

/** The dates a row's day may lie from the account's date now, after a zone change: zones span 26 hours. */
export const ZONE_DAYS = 2;

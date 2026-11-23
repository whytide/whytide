// The values of credits' rules (docs/rules/coding.md "constants"), beside the code that reads them,
// and the price notice's default, which settings.ts reads.

/**
 * CREDITS_PRICE_CHANGE_NOTICE_DAYS's default (settings.ts, README "Settings"): the days a price rise
 * is announced before it applies (README "Declaring a price"); set, 1 or more, no maximum.
 */
export const PRICE_NOTICE_DAYS = { default: 30 } as const;

/** A day of a notice, in milliseconds: 24 hours, whatever the clocks of a time zone do. */
export const DAY_MS = 24 * 60 * 60_000;

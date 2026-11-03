// The LinkedIn screen's tunable values, beside the code that reads them.

/** The shimmering lines of the account's card and of its reads today while the account loads. */
export const LOADING_LINES = [6, 4] as const;

/** The shimmering lines of the health card while it loads. */
export const HEALTH_LOADING_LINES = 3;
/** "Check status": the health asked for again every few seconds, a minute at most. */
export const HEALTH_POLL_MS = 3_000;
export const HEALTH_POLLS = 20;

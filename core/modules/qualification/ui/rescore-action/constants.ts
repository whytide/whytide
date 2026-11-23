// How the Re-score panel reads the lead after a press (rescore-action.tsx; README "Screen"): every
// few seconds until it leaves pending, about three minutes at most.

/** The time between two reads of the lead, in milliseconds. */
export const POLL_MS = 3_000;

/** The reads of the lead after a press, POLL_MS apart: about three minutes. */
export const POLL_LIMIT = 60;

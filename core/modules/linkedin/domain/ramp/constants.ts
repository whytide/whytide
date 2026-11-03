// The ramp's numbers (docs/concepts.md "Ramp"; briefs RB-11.2.3, reduced to the standard tier for
// every account): how often and by how much the daily job raises an account's targets while it sends,
// and when an idle account restarts at half. The targets start at, and stop at, domain/quota's
// INVITES_PER_DAY and MESSAGES_PER_DAY (`start`, `target`), inside linkedin_send_quotas' CHECKs.

/** Quota days from one step of the ramp to the next, at least (RB-11.2.3, standard tier: 2). */
export const RAMP_EVERY_DAYS = 2;

/** Connection requests a day a step adds (RB-11.2.3, standard tier: +2). */
export const RAMP_INVITE_STEP = 2;

/** Messages a day a step adds (not in the sources: 10 to 40 in the 14 days invites take). */
export const RAMP_MESSAGE_STEP = 5;

/** Quota days without a committed send after which the ramp restarts (RB-11.2.3: 14 or more). */
export const RAMP_IDLE_DAYS = 14;

/** The share of its final target an idle account restarts at, rounded down (RB-11.2.3: 50%). */
export const RAMP_RESTART_SHARE = 0.5;

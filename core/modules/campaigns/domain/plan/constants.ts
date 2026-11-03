// The daily plan's numbers (docs/flows.md "The daily plan"; briefs RB-9.2.1, RB-9.2.2, RB-11.2.4),
// beside the code that reads them: place.ts and account.ts here, and the sender of beta-p4-020.

/**
 * The least time between two actions of one account: the smallest gap inside a session in
 * RB-11.2.4 (40 s to 6 min). The plan keeps every two times of an account this far apart, and its
 * first new time this far after the account's last send; the sender waits it before each claim.
 */
export const MIN_ACTION_GAP_MS = 40_000;

/** Steps a person may get on one quota day, across the account's actions (RB-9.2.2). */
export const TOUCHES_PER_PERSON_PER_DAY = 1;

/**
 * The order capacity is given in: messages, then withdrawals, then connection requests, so a
 * started conversation does not stall behind new invites (RB-9.2.1); withdrawals before invites is
 * not in the sources: a withdrawal lowers the pending count that can refuse an invite.
 */
export const ACTION_ORDER = ["message", "withdraw", "invite"] as const;

export type PlanAction = (typeof ACTION_ORDER)[number];

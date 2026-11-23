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

/**
 * The actions whose candidates go by their persons' priority, the higher first (gamma-p5-070,
 * RB-9.2.1): messages and invites. Withdrawals keep beta's order, by due time, as a priority would
 * withdraw a Hot lead's invitation first (not in the sources).
 */
export const PRIORITY_ACTIONS: ReadonlySet<PlanAction> = new Set(["message", "invite"]);

/**
 * The persons one call of qualification's leadPriorities takes at most (its LEAD_PRIORITIES_MAX,
 * which its index does not export): an account's due persons are read in pages of this many, one
 * call each, so an account with more never fails its plan on the read (gamma-p5-070).
 */
export const PRIORITY_READ_MAX = 1000;

/**
 * The prefix of a sender's plan lock (gamma-p6-040, account.ts), a transaction-scoped advisory lock
 * keyed `<prefix>:<workspace id>:<sender id>`: one plan run per sender at a time, so an attempt
 * past PLAN_TIMEOUT never overlaps the next on the same sender. A mailbox's plan takes the same
 * (gamma-p4-010): an account's and a mailbox's ids never meet, their prefixes differ.
 */
export const PLAN_LOCK = "campaigns.plan";

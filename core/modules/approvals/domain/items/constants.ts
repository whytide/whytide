// approvals' values (README.md "Decided here"; docs/rules/coding.md "constants"): plain values the
// domain, the schemas and the events read; nothing imported.

/**
 * APPROVALS_QUEUE_WINDOW_HOURS's default (settings.ts, README.md "Settings"): how far ahead of its due
 * time a step enters "Up next"; campaigns' queue reads the setting (beta-p3-050).
 */
export const QUEUE_WINDOW_HOURS = { default: 24 } as const;
/**
 * APPROVALS_NEEDS_ATTENTION_AFTER_DAYS's default (settings.ts): an item pending this many days or
 * more needs attention (F13 R3).
 */
export const NEEDS_ATTENTION_AFTER_DAYS = { default: 3 } as const;
/**
 * APPROVALS_SMALL_EDIT_MAX_RATIO's default (settings.ts): the largest edit ratio that is still a small
 * edit (not in the sources: "small edits" has no number).
 */
export const SMALL_EDIT_MAX_RATIO = { default: 0.2 } as const;
/** The most items the queue's list answers (not in the sources). */
export const ITEMS_LIST_MAX = 200;

/** The steps that wait for an approval: a connection request, a message and an email (gamma-p4-090). */
export const ACTION_TYPES = ["invite", "message", "email"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
/** The action an email item has: it goes out from a mailbox, every other from a LinkedIn account. */
export const EMAIL_ACTION = "email" as const;
/** The channels an item goes out on, by its action: an email's, else LinkedIn's. */
export const CHANNELS = ["linkedin", "email"] as const;
export type Channel = (typeof CHANNELS)[number];
/** Who approves an item: a person, the default, or the campaign's mode once its draft is ready. */
export const APPROVAL_BY = ["person", "mode"] as const;
export type ApprovalBy = (typeof APPROVAL_BY)[number];
/** An item's statuses: it moves once, from `pending` to one of the others. */
export const ITEM_STATUSES = ["pending", "approved", "skipped", "blocked"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
/** The decisions, the statuses an owner's press leaves; approvals.item_decided carries one. */
export const DECISIONS = ["approved", "skipped"] as const;
export type Decision = (typeof DECISIONS)[number];
/** Where a person's decision was made: the app, the only origin in beta. */
export const DECISION_ORIGIN = "app" as const;
/** The origin of an approval by the campaign's mode, which no person made (gamma-p4-090). */
export const MODE_ORIGIN = "approval_mode" as const;
export type DecisionOrigin = typeof DECISION_ORIGIN | typeof MODE_ORIGIN;
/** The draft's status the mode approves: ready, as its writer left it, and no other. */
export const MODE_DRAFT_STATUS = "ready";
/** The wait of a pending item the mode left to a person: "Up next" says why. */
export const MODE_DECLINED = "mode_declined";
/** The drafts' statuses that end a write: the item's draft is attached then (messaging's ends). */
export const DRAFT_ENDS: readonly string[] = ["ready", "flagged", "failed"];

/** campaigns' withdrawal step: it sends nothing to the person, so it needs no approval. */
export const WITHDRAW_STEP_KEY = "withdraw";
/** A step key as the template writes them: `connect`, `message_1`. */
export const STEP_KEY = /^[a-z][a-z0-9_]{0,63}$/;
/** The reason an approved step waits, a code: `insufficient_credits`, the note budget's. */
export const WAIT_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** The longest id a command takes, as messaging's and contacts' take them. */
export const ID_MAX = 64;
/**
 * The longest text, or an email's subject, an approval takes as given; messaging trims it and its
 * gates hold it shorter.
 */
export const APPROVAL_TEXT_MAX = 4_000;

/** The longest a local day lasts, a clock change included: how far back "decided today" looks. */
export const LOCAL_DAY_MAX_HOURS = 26;
/** The zone a day is counted in when an item's sender account is gone. */
export const FALLBACK_TIME_ZONE = "UTC";
/** The local clock time a day starts at. */
export const MIDNIGHT = "00:00";
export const MS_PER_HOUR = 3_600_000;
export const HOURS_PER_DAY = 24;

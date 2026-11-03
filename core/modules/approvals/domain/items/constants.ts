// approvals' values (README.md "Decided here"; docs/rules/coding.md "constants"): plain values the
// domain, the schemas and the events read; nothing imported.

/** How far ahead of its due time a step enters "Up next": campaigns' queue reads it (beta-p3-050). */
export const QUEUE_WINDOW_HOURS = 24;
/** An item pending this many days or more needs attention (F13 R3). */
export const NEEDS_ATTENTION_AFTER_DAYS = 3;
/** The largest edit ratio that is still a small edit (not in the sources: "small edits" has no number). */
export const SMALL_EDIT_MAX_RATIO = 0.2;
/** The most items the queue's list answers (not in the sources). */
export const ITEMS_LIST_MAX = 200;

/** The steps that wait for an approval: a connection request and a message. */
export const ACTION_TYPES = ["invite", "message"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
/** An item's statuses: it moves once, from `pending` to one of the others. */
export const ITEM_STATUSES = ["pending", "approved", "skipped", "blocked"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
/** The decisions, the statuses an owner's press leaves; approvals.item_decided carries one. */
export const DECISIONS = ["approved", "skipped"] as const;
export type Decision = (typeof DECISIONS)[number];
/** Where a decision was made: the app, the only origin in beta. */
export const DECISION_ORIGIN = "app" as const;
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
/** The longest text an approval takes as given; messaging trims it and its gates hold it shorter. */
export const APPROVAL_TEXT_MAX = 4_000;

/** The longest a local day lasts, a clock change included: how far back "decided today" looks. */
export const LOCAL_DAY_MAX_HOURS = 26;
/** The zone a day is counted in when an item's sender account is gone. */
export const FALLBACK_TIME_ZONE = "UTC";
/** The local clock time a day starts at. */
export const MIDNIGHT = "00:00";
export const MS_PER_HOUR = 3_600_000;
export const HOURS_PER_DAY = 24;

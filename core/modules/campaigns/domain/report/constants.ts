// The fixed values of the "Done when" report's figures (README.md "Commands"; docs/runbook.md "The
// report"): what counts as an action, the reasons a zero is broken, and the units of its days. The
// command's own values, the run's limits and the targets, are cli/constants.ts.
import { MS_PER_HOUR } from "../constants.ts";

/** The actions the zeros check: a withdrawal removes a pending invite and sends the person nothing. */
export const ACTION_KINDS = Object.freeze(["invite", "message"] as const);
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * Why a send counts against "nothing is sent without approval": approvals answers no approved text
 * for its step; its item or its hash is not the one the gate stored with the send (jit_checks); or the
 * approval came after the send.
 */
export const APPROVAL_BREACHES = Object.freeze([
  "no_approval",
  "item_mismatch",
  "approved_after_send",
] as const);
export type ApprovalBreach = (typeof APPROVAL_BREACHES)[number];

/**
 * contacts' suppression reasons a send counts against: the person opted out, or was on the
 * never-contact list as a person or through their company, at the send's instant. person_not_found,
 * a person erased since the send, rebuilds no list and is not counted.
 */
export const COUNTED_SUPPRESSIONS = Object.freeze([
  "opted_out",
  "never_contact_person",
  "never_contact_company",
] as const);

/** The epoch: a read from it sees every row, the period without --since. */
export const EVERY_ROW_SINCE_MS = 0;
export const HOURS_PER_DAY = 24;
export const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;
/** A day's label as an ISO instant starts: `YYYY-MM-DD`. */
export const DAY_LENGTH = 10;
/** ISO's number of Sunday, which Date's getUTCDay gives as 0. */
export const ISO_SUNDAY = 7;

/**
 * The decisions are read from this many days before the decision window, so that its first local
 * day is whole in any zone, a daylight-saving change included; the days are then cut to the window.
 */
export const DECISION_READ_MARGIN_DAYS = 2;
/**
 * The zone of a sender linkedin no longer holds: approvals' own fallback (its domain/items/
 * constants.ts FALLBACK_TIME_ZONE), so both read the same local days.
 */
export const FALLBACK_TIME_ZONE = "UTC";

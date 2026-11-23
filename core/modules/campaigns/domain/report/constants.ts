// The fixed values of the "Done when" report's figures (README.md "Commands"; docs/runbook.md "The
// report"): what counts as an action, the reasons a zero is broken, and the units of its days. The
// command's own values, the run's limits and the targets, are cli/constants.ts.
import type { SuppressionChannel } from "@whytide/contacts";
import { MS_PER_HOUR } from "../constants.ts";

/** The actions the zeros check: a withdrawal removes a pending invite and sends the person nothing. */
export const ACTION_KINDS = Object.freeze(["invite", "message"] as const);
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * Why a send counts against "nothing is sent without approval": approvals answers no approved text
 * for its step; the mode approved it where a person's approval was needed, a first touch or a send
 * in review_everything (gamma-p4-070); its item or its hash is not the one the gate stored with the
 * send (jit_checks); or the approval came after the send.
 */
export const APPROVAL_BREACHES = Object.freeze([
  "no_approval",
  "mode_not_allowed",
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

/**
 * The channel of every send the zeros read: linkedin's log holds LinkedIn's alone, so an entry on
 * email alone does not count against it (gamma-p7-050; contacts' suppressedAt per channel).
 */
export const LINKEDIN_CHANNEL = "linkedin" satisfies SuppressionChannel;
/** contacts' suppression reason of a person erased since the send: sends_person_erased. */
export const PERSON_ERASED = "person_not_found";

/** The health state restrictions_per_100 counts, among linkedin's warnings. */
export const RESTRICTED_STATE = "restricted";
/** restrictions_per_100's scale: per this many active accounts. */
export const PER_HUNDRED = 100;

/** contacts' review decisions review_approval counts: Good lead approves, Not a fit rejects. */
export const APPROVED_REVIEW = "good_lead";
export const REJECTED_REVIEW = "not_a_fit";

/** The epoch: a read from it sees every row, the period without --since. */
export const EVERY_ROW_SINCE_MS = 0;
export const HOURS_PER_DAY = 24;
export const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;
/** A day's label as an ISO instant starts: `YYYY-MM-DD`. */
export const DAY_LENGTH = 10;
/** ISO's number of Sunday, which Date's getUTCDay gives as 0. */
export const ISO_SUNDAY = 7;
/** A month's label as a day's starts: `YYYY-MM`. */
export const MONTH_LENGTH = 7;
/** A year's digits as a day's label starts. */
export const YEAR_LENGTH = 4;
/** ISO's number of Thursday: an ISO week belongs to the year of its Thursday. */
export const ISO_THURSDAY = 4;
export const DAYS_PER_WEEK = 7;
/** An ISO week's number is written with two digits: `YYYY-Www`. */
export const WEEK_DIGITS = 2;
/** What a year's label is followed by to name its first day. */
export const FIRST_OF_YEAR = "-01-01";

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

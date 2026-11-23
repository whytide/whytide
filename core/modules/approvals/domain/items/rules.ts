// The items' rules in time and in edits (README.md "Decided here"; docs/concepts.md), pure: the
// flags the queue computes when it is read, never stored, the days a decision falls on in its
// sender's zone, and what counts as an unedited approval or a small edit.
import { instantAt, quotaDay } from "@whytide/platform";
import { settings } from "../../settings.ts";
import { type ActionType, HOURS_PER_DAY, MIDNIGHT, MS_PER_HOUR } from "./constants.ts";

/** Stale: the step's local day, in the sender's zone, is before today there (RB-14.2.1's roll). */
export const isStale = (scheduledFor: Date, now: Date, timeZone: string): boolean =>
  quotaDay(scheduledFor, timeZone) < quotaDay(now, timeZone);

/** Needs attention: pending APPROVALS_NEEDS_ATTENTION_AFTER_DAYS days or more (F13 R3). */
export const needsAttention = (createdAt: Date, now: Date): boolean =>
  now.getTime() - createdAt.getTime() >=
  settings.APPROVALS_NEEDS_ATTENTION_AFTER_DAYS * HOURS_PER_DAY * MS_PER_HOUR;

/** Today's start in the zone: its local midnight, or the first instant of the day when skipped. */
export const startOfDay = (now: Date, timeZone: string): Date =>
  instantAt(quotaDay(now, timeZone), MIDNIGHT, timeZone);

/** A small edit: an edit ratio above 0 and at most APPROVALS_SMALL_EDIT_MAX_RATIO. */
export const isSmallEdit = (ratio: number): boolean =>
  ratio > 0 && ratio <= settings.APPROVALS_SMALL_EDIT_MAX_RATIO;

/** An approved item's draft as the edit report reads it (messaging's stepDrafts). */
export type ApprovedDraft = {
  readonly actionType: ActionType;
  readonly text: string | null;
  readonly editedByUser: boolean;
  readonly editRatio: number | null;
};
export type EditStats = {
  readonly approved: number;
  readonly unedited: number;
  readonly smallEdits: number;
};

/**
 * The approvals, those unedited and those with a small edit. An invite approved with an empty note
 * is left out: no text was written, so there is no edit to count.
 */
export function countEdits(approvals: readonly ApprovedDraft[]): EditStats {
  const counted = approvals.filter(({ actionType, text }) => actionType !== "invite" || !!text);
  return {
    approved: counted.length,
    unedited: counted.filter(({ editedByUser }) => !editedByUser).length,
    smallEdits: counted.filter(({ editRatio }) => isSmallEdit(editRatio ?? 0)).length,
  };
}

/** A decision as the day counts read it, by its sender's id (store.ts senderIdOf). */
export type Decided = { readonly senderAccountId: string; readonly decidedAt: Date | null };
export type DecisionDay = {
  /** The sender's id: the LinkedIn account's, or an email item's mailbox's (gamma-p4-090). */
  readonly senderAccountId: string;
  /** The local date in the sender's zone, `YYYY-MM-DD`. */
  readonly day: string;
  readonly decisions: number;
};

/**
 * Each sender's decisions made since today's start in that sender's own zone, by its id; a sender
 * with none today is left out (gamma-p6-050: a member's senders may sit in two zones).
 */
export function countTodayBySender(
  decided: readonly Decided[],
  now: Date,
  zoneOf: (senderAccountId: string) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { senderAccountId, decidedAt } of decided) {
    const start = startOfDay(now, zoneOf(senderAccountId));
    if (decidedAt === null || decidedAt.getTime() < start.getTime()) continue;
    counts.set(senderAccountId, (counts.get(senderAccountId) ?? 0) + 1);
  }
  return counts;
}

/** The local days with at least one decision, per sender, by sender then day. */
export function daysOf(
  decided: readonly Decided[],
  zoneOf: (senderAccountId: string) => string,
): DecisionDay[] {
  const counts = new Map<string, DecisionDay>();
  for (const { senderAccountId, decidedAt } of decided) {
    if (decidedAt === null) continue;
    const day = quotaDay(decidedAt, zoneOf(senderAccountId));
    const key = `${senderAccountId} ${day}`;
    const decisions = (counts.get(key)?.decisions ?? 0) + 1;
    counts.set(key, { senderAccountId, day, decisions });
  }
  const order = (a: DecisionDay, b: DecisionDay) =>
    compare(a.senderAccountId, b.senderAccountId) || compare(a.day, b.day);
  return [...counts.values()].sort(order);
}

/** By code unit, as ids and ISO dates sort, whatever the locale. */
export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

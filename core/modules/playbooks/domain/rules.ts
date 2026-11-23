// The rules of an agent's sources and statuses (README "Decided here"), plain functions that the
// commands and the unit tests share.
import type { PausedReason, PlaybookStatus, SourceCode } from "./constants.ts";
import type { SourceCheck } from "./source-checker.ts";

/**
 * Why the agent of `ownerUserId` cannot hold the source, or null when it can: a source the checker
 * did not find, then one whose reading owner is not the agent's (a source that reads through an
 * account of another member, or whose account is gone, or, with no account at all, one another member
 * made; gamma-wr-030), then one another agent holds.
 */
export function refusalOf(
  check: SourceCheck | undefined,
  ownerUserId: string,
  heldByAnother: boolean,
): SourceCode | null {
  if (check === undefined || !check.found) return "playbook_source_not_found";
  if (check.readingOwnerUserId !== ownerUserId) return "playbook_source_wrong_owner";
  return heldByAnother ? "playbook_source_in_use" : null;
}

/** The ids once each, in the order they first come. */
export const uniqueIds = (ids: readonly string[]): string[] => [...new Set(ids)];

/** archived_at for a status: set exactly when archived (the CHECK playbooks_archived_at). */
export const archivedAtFor = (status: PlaybookStatus, now: Date): Date | null =>
  status === "archived" ? now : null;

/**
 * paused_reason for a status (the CHECK playbooks_paused_reason): set exactly while paused. A pause
 * through the PATCH is the member's, `user`; an agent paused already keeps its reason, so that a
 * removal's pause never turns into a member's.
 */
export function pausedReasonFor(
  status: PlaybookStatus,
  current: { readonly status: PlaybookStatus; readonly pausedReason: PausedReason | null },
): PausedReason | null {
  if (status !== "paused") return null;
  return current.status === "paused" ? (current.pausedReason ?? "user") : "user";
}

/**
 * Whether `userId` may not take the agent out of its pause to `status`: an agent paused for its
 * owner's removal is resumed by that owner alone, once a member again; anyone else, an Owner
 * included, is refused. Archiving it is not a resume.
 */
export function refusesResume(
  agent: {
    readonly status: PlaybookStatus;
    readonly pausedReason: PausedReason | null;
    readonly ownerUserId: string;
  },
  status: PlaybookStatus,
  userId: string,
): boolean {
  const removed = agent.status === "paused" && agent.pausedReason === "member_removed";
  return removed && status === "active" && agent.ownerUserId !== userId;
}

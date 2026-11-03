// The pending invitations (docs/concepts.md "Pending invitations"): what the account's count says of
// a new invite, failing closed, and what the day's check makes of the vendor's answers, pure. The
// count is the day's check's (check.ts), plus one for each invite committed since (send/settle.ts).
import type { SenderAccount } from "../accounts.ts";
import { PENDING_INVITES_FRESH_MS, PENDING_INVITES_MAX } from "./constants.ts";

export type PendingRefusal = "pending_invites_unknown" | "pending_invites_over_limit";
/** An invite pending at the vendor, as listPendingInvites pages it. */
export type PendingInvite = { readonly invitationRef: string; readonly memberRef: string };
/** An outreach row whose invite the check may ask about: its refs at the vendor. */
export type InvitedRow = {
  readonly id: string;
  readonly personId: string;
  readonly providerMemberRef: string | null;
  readonly providerInvitationRef: string | null;
};
/** What getRelation answers of an invite no longer pending. */
export type Relation = { readonly connected: boolean; readonly invitationPending: boolean };

/**
 * A new invite's refusal at `at`, or null: unknown while never counted or counted more than
 * PENDING_INVITES_FRESH_HOURS ago; over the limit when the count and `held`, the account's invites
 * reserved and not settled, which may each go out before the next count (held.ts), pass
 * PENDING_INVITES_MAX.
 */
export function pendingRefusal(
  account: Pick<SenderAccount, "pendingInvites" | "pendingInvitesCheckedAt">,
  at: Date,
  held = 0,
): PendingRefusal | null {
  const { pendingInvites, pendingInvitesCheckedAt: checkedAt } = account;
  if (pendingInvites === null || checkedAt === null) return "pending_invites_unknown";
  if (at.getTime() - checkedAt.getTime() > PENDING_INVITES_FRESH_MS) {
    return "pending_invites_unknown";
  }
  return pendingInvites + held > PENDING_INVITES_MAX ? "pending_invites_over_limit" : null;
}

/**
 * The rows whose invite is no longer pending: neither their invitation's ref nor their member's is
 * on the vendor's list. A row without the member's ref cannot be asked, and is left.
 */
export function missedOf(
  rows: readonly InvitedRow[],
  pending: readonly PendingInvite[],
): (InvitedRow & { readonly providerMemberRef: string })[] {
  const invitations = new Set(pending.map((invite) => invite.invitationRef));
  const members = new Set(pending.map((invite) => invite.memberRef));
  return rows.filter(
    (row): row is InvitedRow & { readonly providerMemberRef: string } =>
      row.providerMemberRef !== null &&
      !members.has(row.providerMemberRef) &&
      (row.providerInvitationRef === null || !invitations.has(row.providerInvitationRef)),
  );
}

/**
 * An invite no longer on the list, by its relation now: `accepted` once connected; `gone`, declined
 * or withdrawn by hand, when neither connected nor pending; `pending` when the vendor still has it.
 */
export function relationOutcome(relation: Relation): "accepted" | "gone" | "pending" {
  if (relation.connected) return "accepted";
  return relation.invitationPending ? "pending" : "gone";
}

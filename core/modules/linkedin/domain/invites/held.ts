// The account's invites in flight (docs/concepts.md "Pending invitations"; beta-p6-020): each reserved
// and not settled may go out before the next count, so the 400 counts them with the pending ones, in
// the caller's run. A reservation and campaigns' plan count them all; the send activity's gate just
// before the call counts the others than its own, so two invites in flight at 400 cannot both pass.
import { tenantClient } from "@whytide/db";
import type { SenderAccount } from "../accounts.ts";
import { type PendingRefusal, pendingRefusal } from "./pending.ts";

type Counted = Pick<SenderAccount, "id" | "pendingInvites" | "pendingInvitesCheckedAt">;

/**
 * The pending count's refusal of a new invite at `at` (pendingRefusal), the account's invite
 * reservations held at `at` counted with it, `own`'s aside; their count is read only when the count
 * alone lets the invite through.
 */
export async function heldRefusal(
  account: Counted,
  at: Date,
  own?: string,
): Promise<PendingRefusal | null> {
  const refused = pendingRefusal(account, at);
  if (refused !== null) return refused;
  const held = await tenantClient.senderQuotaReservation.count({
    where: {
      senderAccountId: account.id,
      actionType: "invite",
      status: "reserved",
      expiresAt: { gt: at },
      ...(own === undefined ? {} : { id: { not: own } }),
    },
  });
  return pendingRefusal(account, at, held);
}

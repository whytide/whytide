// A removed member's accounts (gamma-p6-070; README "Kill switches", docs/flows.md "A member's
// removal"): tenancy.member_removed, delivered in a tenant run of the event's workspace (events.ts),
// pauses each of the user's accounts there with the source member_removed and one control event each
// by the system, in the delivery's transaction, so from the next reservation nothing is read or sent
// through them. A tester's pause is taken over; the operator's stays the operator's; a redelivery
// finds them paused and writes nothing. Only the account's owner lifts it, once invited again.
import { tenantClient } from "@whytide/db";
import { pauseAsRemoved } from "./controls/controls.ts";

/** The user's accounts in the run's workspace paused for their removal: how many moved. */
export async function pauseRemovedMember(userId: string): Promise<number> {
  // Prisma drops an undefined value from a where: unchecked, that would be every account.
  if (!userId) return 0;
  const accounts = await tenantClient.senderAccount.findMany({
    where: { ownerUserId: userId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  let moved = 0;
  for (const { id } of accounts) if (await pauseAsRemoved(id)) moved += 1;
  return moved;
}

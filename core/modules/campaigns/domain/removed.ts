// A removed member (gamma-p6-040; README.md "A removed member"; docs/flows.md "A removed member"):
// the body of the subscriber to tenancy.member_removed (events.ts), in the delivery's transaction.
// Nothing goes out from a removed member's senders: each live enrollment, a paused one too, of a
// campaign the user owns (campaigns.owner_user_id), and each other one that sends from the user's
// LinkedIn account (beta's, made with the approver's account), ends as no-sender.ts ends one, with
// owner_removed. The accounts' owners are linkedin's, each account read once: one linkedin no longer
// holds is no one's. An `executing` step is left to the gate, which checks the owner again right
// before its send. A redelivery finds no live enrollment of the user's and changes nothing.
import type { TenantClient } from "@whytide/db";
import { LIVE_ENROLLMENT_STATUSES } from "./constants.ts";
import { endWithoutSender } from "./no-sender.ts";
import { accountOwnerOf } from "./owner.ts";

/** The live enrollments of the user's campaigns and accounts ended at `at`: how many. */
export async function endRemovedEnrollments(
  tx: TenantClient,
  userId: string,
  at: Date,
): Promise<number> {
  // Prisma drops an undefined value from a where: unchecked, that would be every campaign.
  if (typeof userId !== "string" || userId === "") return 0;
  const live = { status: { in: [...LIVE_ENROLLMENT_STATUSES] } };
  const owned = await tx.campaign.findMany({
    where: { ownerUserId: userId },
    select: { keyRef: true },
  });
  const senders = await tx.enrollment.findMany({
    where: { ...live, senderAccountId: { not: null } },
    distinct: ["senderAccountId"],
    select: { senderAccountId: true },
  });
  const accounts: string[] = [];
  for (const { senderAccountId } of senders) {
    if (senderAccountId !== null && (await accountOwnerOf(senderAccountId)) === userId) {
      accounts.push(senderAccountId);
    }
  }
  const ending = await tx.enrollment.findMany({
    where: {
      ...live,
      OR: [
        { templateId: { in: owned.map(({ keyRef }) => keyRef) } },
        { senderAccountId: { in: accounts } },
      ],
    },
    select: { id: true, personId: true, templateId: true },
    orderBy: { id: "asc" },
  });
  let ended = 0;
  for (const enrollment of ending) {
    if (await endWithoutSender(tx, enrollment, "owner_removed", at)) ended += 1;
  }
  return ended;
}

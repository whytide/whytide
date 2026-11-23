// A replaced sender account (beta-p4-040; README.md "Worker"; docs/flows.md "A replaced account"):
// the body of the subscriber to linkedin.account_replaced (events.ts), in the delivery's
// transaction. Another LinkedIn account is behind the row now, so nothing planned for the old one
// goes from it: each live enrollment of the account, a paused one too, `exited` (`no_sender`,
// `exit_detail` account_replaced), its `planned`, `awaiting_approval` and `scheduled` steps
// `cancelled` with the reason and their pending items blocked (approvals' cancelItems), and its
// lead `finished` (not in the sources), as no-sender.ts ends one. An `executing` step is left to the
// sender's check. Each person's rows are locked in the order every stop takes: the lead, the
// enrollment, the steps, the items. A redelivery finds no live enrollment and changes nothing.
import type { TenantClient } from "@whytide/db";
import { LIVE_ENROLLMENT_STATUSES } from "./constants.ts";
import { endWithoutSender } from "./no-sender.ts";

/** The account's active enrollments ended at `at` (the file's header): how many. */
export async function endReplacedEnrollments(
  tx: TenantClient,
  senderAccountId: string,
  at: Date,
): Promise<number> {
  const active = await tx.enrollment.findMany({
    where: { senderAccountId, status: { in: [...LIVE_ENROLLMENT_STATUSES] } },
    select: { id: true, personId: true, templateId: true },
    orderBy: { id: "asc" },
  });
  let ended = 0;
  for (const enrollment of active) {
    if (await endWithoutSender(tx, enrollment, "account_replaced", at)) ended += 1;
  }
  return ended;
}

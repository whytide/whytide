// A replaced sender account (beta-p4-040; README.md "Worker"; docs/flows.md "A replaced account"):
// the body of the subscriber to linkedin.account_replaced (events.ts), in the delivery's
// transaction. Another LinkedIn account is behind the row now, so nothing planned for the old one
// goes from it: each `active` enrollment of the account `exited` (`no_sender`, `exit_detail`
// account_replaced), its `planned`, `awaiting_approval` and `scheduled` steps `cancelled` with the
// reason and their pending items blocked (approvals' cancelItems), and its lead `finished` (not in
// the sources). An `executing` step is left to the sender's check. Each person's rows are locked in
// the order every stop takes: the lead, the enrollment, the steps, the items. A redelivery finds no
// active enrollment and changes nothing.
import { cancelItems } from "@whytide/approvals";
import { lockLeadStatus } from "@whytide/contacts";
import type { TenantClient } from "@whytide/db";
import { PENDING_STEP_STATUSES } from "./gate/constants.ts";
import { checkedCode } from "./steps/codes.ts";
import { EXIT_DETAILS, STEP_REASON_CODES } from "./steps/constants.ts";
import { finishLead, lockEnrollment } from "./steps/skip.ts";

const SYSTEM = { type: "system" } as const;

/** The account's active enrollments ended at `at` (the file's header): how many. */
export async function endReplacedEnrollments(
  tx: TenantClient,
  senderAccountId: string,
  at: Date,
): Promise<number> {
  const skipReason = checkedCode(STEP_REASON_CODES, "skip_reason", "account_replaced");
  const exitDetail = checkedCode(EXIT_DETAILS, "exit_detail", "account_replaced");
  const active = await tx.enrollment.findMany({
    where: { senderAccountId, status: "active" },
    select: { id: true, personId: true, templateId: true },
    orderBy: { id: "asc" },
  });
  let ended = 0;
  for (const enrollment of active) {
    await lockLeadStatus(enrollment.personId);
    await lockEnrollment(tx, enrollment.id);
    const { count } = await tx.enrollment.updateMany({
      where: { id: enrollment.id, status: "active" },
      data: { status: "exited", exitReason: "no_sender", exitDetail, endedAt: at },
    });
    if (count === 0) continue;
    const cancelled = await tx.stepExecution.updateManyAndReturn({
      where: { enrollmentId: enrollment.id, status: { in: [...PENDING_STEP_STATUSES] } },
      data: { status: "cancelled", skipReason },
      select: { id: true },
    });
    await cancelItems(cancelled.map(({ id }) => id));
    await finishLead(enrollment, SYSTEM);
    ended += 1;
  }
  return ended;
}

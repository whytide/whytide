// An enrollment that can no longer send (README.md "Worker", "A removed member"; docs/flows.md "A
// replaced account", "A removed member"): another LinkedIn account behind its sender account
// (account_replaced, beta-p4-040, replaced.ts), or its sender's owner no longer an active member of
// the workspace (owner_removed, gamma-p6-040, removed.ts and the gate). In the caller's transaction,
// under the locks every stop takes, in their order: the lead, the enrollment, the steps, the items.
// The enrollment `exited` (`no_sender`, the code in `exit_detail`) if still live, a paused one too;
// its `planned`, `awaiting_approval` and `scheduled` steps `cancelled` with the code and their
// pending items blocked (approvals' cancelItems); its lead `finished` (not in the sources). An
// `executing` step is left to its sender's gate.
import { cancelItems } from "@whytide/approvals";
import { lockLeadStatus } from "@whytide/contacts";
import type { TenantClient } from "@whytide/db";
import { LIVE_ENROLLMENT_STATUSES, NO_PAUSE } from "./constants.ts";
import { PENDING_STEP_STATUSES } from "./gate/constants.ts";
import { checkedCode } from "./steps/codes.ts";
import { EXIT_DETAILS, STEP_REASON_CODES } from "./steps/constants.ts";
import { finishLead, lockEnrollment } from "./steps/skip.ts";

/** Why an enrollment can no longer send: its exit_detail, and its cancelled steps' skip_reason. */
export type NoSenderCode = "account_replaced" | "owner_removed";
/** An enrollment as an end reads it. */
export type EndedEnrollment = {
  readonly id: string;
  readonly personId: string;
  readonly templateId: string;
};

const SYSTEM = { type: "system" } as const;

/** The enrollment ended at `at` for the code (the file's header): whether it was still live. */
export async function endWithoutSender(
  tx: TenantClient,
  enrollment: EndedEnrollment,
  code: NoSenderCode,
  at: Date,
): Promise<boolean> {
  const skipReason = checkedCode(STEP_REASON_CODES, "skip_reason", code);
  const exitDetail = checkedCode(EXIT_DETAILS, "exit_detail", code);
  await lockLeadStatus(enrollment.personId);
  await lockEnrollment(tx, enrollment.id);
  const { count } = await tx.enrollment.updateMany({
    where: { id: enrollment.id, status: { in: [...LIVE_ENROLLMENT_STATUSES] } },
    data: { status: "exited", exitReason: "no_sender", exitDetail, endedAt: at, ...NO_PAUSE },
  });
  if (count === 0) return false;
  const cancelled = await tx.stepExecution.updateManyAndReturn({
    where: { enrollmentId: enrollment.id, status: { in: [...PENDING_STEP_STATUSES] } },
    data: { status: "cancelled", skipReason },
    select: { id: true },
  });
  await cancelItems(cancelled.map(({ id }) => id));
  await finishLead(enrollment, SYSTEM);
  return true;
}

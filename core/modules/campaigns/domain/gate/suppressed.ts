// A suppressed person's way out (README.md "The gate", "The suppression subscriber"): the gate's
// suppression branch and the subscriber to contacts.suppression_added exit the enrollment and cancel
// the person's pending steps, with the reason, and block their pending items in "Up next". The
// enrollment goes first, as in the hold, so that two stops at once lock their rows in one order. An
// executing step is left to the sender, whose gate runs again before the call.
import { cancelItems } from "@whytide/approvals";
import { suppressionOf } from "@whytide/contacts";
import type { TenantClient } from "@whytide/db";
import { LIVE_ENROLLMENT_STATUSES, NO_PAUSE } from "../constants.ts";
import { checkedCode } from "../steps/codes.ts";
import { EXIT_DETAILS, STEP_REASON_CODES, type StepReasonCode } from "../steps/constants.ts";
import { PENDING_STEP_STATUSES } from "./constants.ts";

/**
 * The enrollment `exited` (`suppressed`, the reason in `exit_detail`) when still live, and the
 * person's pending steps but `keep` `cancelled` with the reason in `skip_reason`, their pending
 * items blocked (approvals' cancelItems): the ids cancelled.
 */
export async function exitSuppressed(
  tx: TenantClient,
  input: {
    enrollmentId: string;
    personId: string;
    reason: StepReasonCode;
    at: Date;
    keep?: string;
  },
): Promise<string[]> {
  const { enrollmentId, personId, reason, at, keep } = input;
  const exitDetail = checkedCode(EXIT_DETAILS, "exit_detail", reason);
  await tx.enrollment.updateMany({
    where: { id: enrollmentId, status: { in: [...LIVE_ENROLLMENT_STATUSES] } },
    data: { status: "exited", exitReason: "suppressed", exitDetail, endedAt: at, ...NO_PAUSE },
  });
  const pending = { personId, status: { in: [...PENDING_STEP_STATUSES] } };
  const steps = await tx.stepExecution.updateManyAndReturn({
    where: keep === undefined ? pending : { ...pending, id: { not: keep } },
    data: { status: "cancelled", skipReason: reason },
    select: { id: true },
  });
  const ids = steps.map(({ id }) => id);
  await cancelItems(ids);
  return ids;
}

/**
 * The subscriber's body: every live enrollment of the workspace, a paused one too, checked again,
 * one suppressionOf per enrollment, and each suppressed person's enrollment exited with their
 * pending steps cancelled. The enrollments exited; none on a second delivery, which finds them
 * ended.
 */
export async function exitSuppressedEnrollments(tx: TenantClient, at: Date): Promise<number> {
  const active = await tx.enrollment.findMany({
    where: { status: { in: [...LIVE_ENROLLMENT_STATUSES] } },
    select: { id: true, personId: true },
    orderBy: { id: "asc" },
  });
  let exited = 0;
  for (const { id, personId } of active) {
    const suppression = await suppressionOf(personId, { newEnrollment: false });
    if (!suppression.suppressed) continue;
    const reason = checkedCode(STEP_REASON_CODES, "skip_reason", suppression.reason);
    await exitSuppressed(tx, { enrollmentId: id, personId, reason, at });
    exited += 1;
  }
  return exited;
}

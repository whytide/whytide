// A withdrawal's settle (README.md "Withdrawals"; docs/flows.md "The withdrawal"), in the sender's
// settle run (../send/settle.ts), under the locks every stop takes, in their order: the lead, the
// enrollment, then the steps and their items. One that went out: the step `succeeded`, the touch
// recorded, so contacts refuses the person a new enrollment for 90 days, campaigns.step_sent
// published, then the end. An invitation already gone, answered after the call with its slot
// committed (INVITATION_GONE_CODES): the step `failed` with the code, the touch recorded all the
// same, then the end. The end: the enrollment `exited` (`not_accepted`) while it is active, its
// pending steps cancelled with their items, the lead finished. A connection request accepted
// meanwhile ends nothing: its enrollment goes on. A withdrawal holds no credits.
import { cancelItems } from "@whytide/approvals";
import { errors as contactsErrors, lockLeadStatus, recordTouch } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { findSendReservation } from "@whytide/linkedin";
import { currentTenant, isAppError, publish } from "@whytide/platform";
import { events } from "../../events.ts";
import { PENDING_STEP_STATUSES } from "../gate/constants.ts";
import { checkedCode } from "../steps/codes.ts";
import { STEP_REASON_CODES } from "../steps/constants.ts";
import { finishLead, lockEnrollment } from "../steps/skip.ts";
import { inviteAcceptedAt } from "./accepted.ts";
import { INVITATION_GONE_CODES } from "./constants.ts";

/** A withdraw step as the settle reads it. */
export type WithdrawStep = {
  readonly id: string;
  readonly enrollmentId: string;
  readonly personId: string;
  readonly templateId: string;
};

const SYSTEM = { type: "system" } as const;
const STEP = { id: true, enrollmentId: true, personId: true, templateId: true } as const;

/** The withdrawal that went out, settled at `at` (the file's header). */
export async function settleWithdrawn(step: WithdrawStep, at: Date): Promise<void> {
  await lockLeadStatus(step.personId);
  await lockEnrollment(tenantClient, step.enrollmentId);
  const { count } = await tenantClient.stepExecution.updateMany({
    where: { id: step.id, status: "executing" },
    data: { status: "succeeded", executedAt: at, errorCode: null },
  });
  if (count === 0) return;
  await touch(step.personId, at);
  const { workspaceId } = currentTenant();
  await publish(outboxWriter(tenantClient, workspaceId), events["campaigns.step_sent"], {
    stepExecutionId: step.id,
    personId: step.personId,
    actionType: "withdraw",
  });
  if ((await inviteAcceptedAt(step.enrollmentId)) === null) await endEnrollment(step, at);
}

/**
 * linkedin's `code` after a call, settled at `at` when it says a withdrawal's invitation is already
 * gone (the file's header): whether it did. A check's refusal before a retry keeps its slot
 * `reserved`, and any other answer is the sender's to settle as it settles any step's.
 */
export async function settleGone(
  stepExecutionId: string,
  code: string,
  reservationId: string,
  at: Date,
): Promise<boolean> {
  if (!(INVITATION_GONE_CODES as readonly string[]).includes(code)) return false;
  const slot = await findSendReservation(reservationId);
  if (slot?.actionType !== "withdraw" || slot.status !== "committed") return false;
  const errorCode = checkedCode(STEP_REASON_CODES, "error_code", code);
  const step = await tenantClient.stepExecution.findFirst({
    where: { id: stepExecutionId, status: "executing" },
    select: STEP,
  });
  // Settled already, by a settle run again, or erased meanwhile: nothing left to write.
  if (step === null) return true;
  await lockLeadStatus(step.personId);
  await lockEnrollment(tenantClient, step.enrollmentId);
  const { count } = await tenantClient.stepExecution.updateMany({
    where: { id: step.id, status: "executing" },
    data: { status: "failed", executedAt: at, errorCode },
  });
  // Accepted meanwhile: the request is a connection now, and the conversation goes on.
  if (count === 0 || (await inviteAcceptedAt(step.enrollmentId)) !== null) return true;
  await touch(step.personId, at);
  await endEnrollment(step, at);
  return true;
}

/** The enrollment `exited` (`not_accepted`) while it is active, and what follows (the header). */
async function endEnrollment(step: WithdrawStep, at: Date): Promise<void> {
  const exited = { status: "exited", exitReason: "not_accepted", endedAt: at } as const;
  const where = { id: step.enrollmentId, status: "active" } as const;
  const { count } = await tenantClient.enrollment.updateMany({ where, data: exited });
  if (count === 0) return;
  const skipReason = checkedCode(STEP_REASON_CODES, "skip_reason", "not_accepted");
  const cancelled = await tenantClient.stepExecution.updateManyAndReturn({
    where: { enrollmentId: step.enrollmentId, status: { in: [...PENDING_STEP_STATUSES] } },
    data: { status: "cancelled", skipReason },
    select: { id: true },
  });
  // The cancelled steps' pending items blocked in this transaction.
  await cancelItems(cancelled.map(({ id }) => id));
  await finishLead(step, SYSTEM);
}

/** The touch on the person; one erased meanwhile has none to record. */
async function touch(personId: string, at: Date): Promise<void> {
  try {
    await recordTouch(personId, at);
  } catch (error) {
    if (!(isAppError(error) && error.code === contactsErrors.person_not_found)) throw error;
  }
}

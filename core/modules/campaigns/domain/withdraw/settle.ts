// A withdrawal's settle (README.md "Withdrawals"; docs/flows.md "The withdrawal"), in the sender's
// settle run (../send/settle.ts), under the locks every stop takes, in their order: the lead, the
// enrollment, then the steps and their items. One that went out: the step `succeeded`, the touch
// recorded, so contacts refuses the person a new enrollment for 90 days, campaigns.step_sent
// published, then the end. An invitation already gone, answered after the call with its slot
// committed (INVITATION_GONE_CODES): the step `failed` with the code, the touch recorded all the
// same, then the end. The end: the enrollment's pending LinkedIn steps cancelled with their items
// (`not_accepted`), a pending fallback email kept, since its condition holds (gamma-p3-060); then,
// with no step left open, the enrollment `exited` (`not_accepted`) and the lead finished
// (../steps/skip.ts endIfDone), else when its last fallback email ends. A connection request
// accepted meanwhile ends nothing: its enrollment goes on. A withdrawal holds no credits.
import { cancelItems } from "@whytide/approvals";
import { errors as contactsErrors, lockLeadStatus, recordTouch } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { findSendReservation } from "@whytide/linkedin";
import { currentTenant, isAppError, publish } from "@whytide/platform";
import { events } from "../../events.ts";
import { versionSteps } from "../campaigns/reads.ts";
import { LIVE_ENROLLMENT_STATUSES } from "../constants.ts";
import { fallbackKeys } from "../fallback/fallback.ts";
import { PENDING_STEP_STATUSES } from "../gate/constants.ts";
import { checkedCode } from "../steps/codes.ts";
import { STEP_REASON_CODES } from "../steps/constants.ts";
import { endIfDone, lockEnrollment } from "../steps/skip.ts";
import { inviteAcceptedAt } from "./accepted.ts";
import { INVITATION_GONE_CODES } from "./constants.ts";

/** A withdraw step as the settle reads it. */
export type WithdrawStep = {
  readonly id: string;
  readonly enrollmentId: string;
  readonly personId: string;
  readonly templateId: string;
  readonly templateVersion: number;
};

const SYSTEM = { type: "system" } as const;
const STEP = {
  id: true,
  enrollmentId: true,
  personId: true,
  templateId: true,
  templateVersion: true,
} as const;

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

/** The end, while the enrollment is live (the file's header). */
async function endEnrollment(step: WithdrawStep, at: Date): Promise<void> {
  const live = { id: step.enrollmentId, status: { in: [...LIVE_ENROLLMENT_STATUSES] } };
  if ((await tenantClient.enrollment.count({ where: live })) === 0) return;
  const steps = (await versionSteps(step.templateId, step.templateVersion)) ?? [];
  const skipReason = checkedCode(STEP_REASON_CODES, "skip_reason", "not_accepted");
  const cancelled = await tenantClient.stepExecution.updateManyAndReturn({
    where: {
      enrollmentId: step.enrollmentId,
      status: { in: [...PENDING_STEP_STATUSES] },
      stepKey: { notIn: fallbackKeys(steps) },
    },
    data: { status: "cancelled", skipReason },
    select: { id: true },
  });
  // The cancelled steps' pending items blocked in this transaction.
  await cancelItems(cancelled.map(({ id }) => id));
  await endIfDone(tenantClient, step, at, SYSTEM);
}

/** The touch on the person; one erased meanwhile has none to record. */
async function touch(personId: string, at: Date): Promise<void> {
  try {
    await recordTouch(personId, at);
  } catch (error) {
    if (!(isAppError(error) && error.code === contactsErrors.person_not_found)) throw error;
  }
}

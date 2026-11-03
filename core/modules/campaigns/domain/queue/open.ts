// A due step into "Up next" (README.md "The queue"; docs/flows.md "The queue"): the body of the
// activity campaigns_queue_step, in one tenant run; message_1's too, once the acceptance set its
// due time (beta-p4-050). The step is checked again as it is now: still `planned` with a due time,
// its enrollment active, its person not suppressed (no draft is paid for: the suppression subscriber
// or the gate ends the step), its sender account still there. Then the step is claimed, `planned` to
// `awaiting_approval` under a condition on `planned`, before approvals' openItem asks messaging for
// its draft, written as the account's owner from the drafts the person was already sent: a hold or
// a cancel that meets the claimed step waits for this run's commit, then blocks the item it opened.
import { openItem } from "@whytide/approvals";
import { suppressionOf } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import { isAppError } from "@whytide/platform";
import { opensItem } from "../steps/actions.ts";
import type { QueueOutcome } from "./constants.ts";

const STEP_FIELDS = {
  id: true,
  status: true,
  enrollmentId: true,
  personId: true,
  senderAccountId: true,
  actionType: true,
  stepKey: true,
  position: true,
  dueAt: true,
} as const;

/** The step's item opened and the step `awaiting_approval` with it, or why not (the file's header). */
export async function queueStep(stepExecutionId: string): Promise<QueueOutcome> {
  // Prisma drops an undefined value from a where: unchecked, that would be any step.
  if (typeof stepExecutionId !== "string" || stepExecutionId === "") return "passed_over";
  const step = await tenantClient.stepExecution.findFirst({
    where: { id: stepExecutionId },
    select: STEP_FIELDS,
  });
  if (step === null || step.status !== "planned") return "passed_over";
  const { actionType, dueAt } = step;
  if (dueAt === null || !opensItem(actionType)) return "passed_over";
  const enrollment = await tenantClient.enrollment.findFirst({
    where: { id: step.enrollmentId },
    select: { status: true },
  });
  if (enrollment?.status !== "active") return "passed_over";
  const suppression = await suppressionOf(step.personId, { newEnrollment: false });
  if (suppression.suppressed) return "passed_over";
  const ownerUserId = await ownerOf(step.senderAccountId);
  if (ownerUserId === null) return "no_sender";

  const claimed = await tenantClient.stepExecution.updateMany({
    where: { id: step.id, status: "planned" },
    data: { status: "awaiting_approval" },
  });
  if (claimed.count === 0) return "passed_over";
  const { approvalItemId } = await openItem({
    stepExecutionId: step.id,
    personId: step.personId,
    senderAccountId: step.senderAccountId,
    actionType,
    stepKey: step.stepKey,
    scheduledFor: dueAt,
    senderUserId: ownerUserId,
    earlierDraftIds: await sentDraftIds(step),
  });
  await tenantClient.stepExecution.updateMany({
    where: { id: step.id, status: "awaiting_approval" },
    data: { approvalItemId },
  });
  return "opened";
}

/** The drafts of the enrollment's steps sent before this one, oldest first. */
async function sentDraftIds(step: { enrollmentId: string; position: number }): Promise<string[]> {
  const sent = await tenantClient.stepExecution.findMany({
    where: {
      enrollmentId: step.enrollmentId,
      status: "succeeded",
      position: { lt: step.position },
      draftId: { not: null },
    },
    orderBy: { position: "asc" },
    select: { draftId: true },
  });
  return sent.flatMap(({ draftId }) => (draftId === null ? [] : [draftId]));
}

/** The account's owner, or null once linkedin no longer holds the account in the run's workspace. */
async function ownerOf(senderAccountId: string): Promise<string | null> {
  try {
    return (await findSenderAccount(senderAccountId)).ownerUserId;
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}

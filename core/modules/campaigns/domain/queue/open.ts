// A due step into "Up next" (README.md "The queue"; docs/flows.md "The queue"): the body of the
// activity campaigns_queue_step, in one tenant run; message_1's too, once the acceptance set its
// due time (beta-p4-050). The step is checked again as it is now: still `planned` with a due time,
// its enrollment active and its campaign active (../pause/), its person not suppressed (no draft is
// paid for: the suppression subscriber or the gate ends the step), its sender account still there
// and its owner an active member of the workspace (gamma-p6-040: a removed owner's step stays
// `planned`, no_sender, until the subscriber to tenancy.member_removed ends it). Then the step is
// claimed, `planned` to `awaiting_approval` under a condition on `planned`, before approvals'
// openItem asks messaging for its draft, written as the account's owner from the drafts the person
// was already sent: a hold or a cancel that meets the claimed step waits for this run's commit, then
// blocks the item it opened. gamma-p4-070: the item is opened for the mode (`approvalBy: "mode"`)
// when the step may take the mode's approval, a follow-up in review_first_touches, else for a
// person, read under a share lock on the campaign's row, before the claim: a change of the mode
// waits for this run, and its switch back then finds this item. review-gaps: a follow-up is a first
// touch, its item a person's, until a message of its action went out from the enrollment (a first
// message skipped, failed or held leaves the next one the lead's first).
import { openItem } from "@whytide/approvals";
import { suppressionOf } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { BY_MODE, BY_PERSON, PERSON_OR_MODE } from "../approval-mode/constants.ts";
import { stepRequirement } from "../approval-mode/requirement.ts";
import { now } from "../clock.ts";
import { accountOwnerOf, isActiveMember } from "../owner.ts";
import { campaignStatusOf } from "../pause/status.ts";
import { linkedinSenderAccount, opensItem } from "../steps/actions.ts";
import type { QueueOutcome } from "./constants.ts";

const STEP_FIELDS = {
  id: true,
  status: true,
  enrollmentId: true,
  personId: true,
  senderAccountId: true,
  actionType: true,
  stepKey: true,
  templateId: true,
  templateVersion: true,
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
    select: { status: true, templateId: true },
  });
  if (enrollment?.status !== "active") return "passed_over";
  if ((await campaignStatusOf(enrollment.templateId)) !== "active") return "passed_over";
  const suppression = await suppressionOf(step.personId, { newEnrollment: false });
  if (suppression.suppressed) return "passed_over";
  // Past opensItem, a connection request or a message: a LinkedIn step, with its account.
  const senderAccountId = linkedinSenderAccount(step);
  const ownerUserId = await accountOwnerOf(senderAccountId);
  if (ownerUserId === null || !(await isActiveMember(ownerUserId))) return "no_sender";
  const { required } = await stepRequirement(step, now(), { lock: "share" });

  const claimed = await tenantClient.stepExecution.updateMany({
    where: { id: step.id, status: "planned" },
    data: { status: "awaiting_approval" },
  });
  if (claimed.count === 0) return "passed_over";
  const { approvalItemId } = await openItem({
    stepExecutionId: step.id,
    personId: step.personId,
    senderAccountId,
    actionType,
    stepKey: step.stepKey,
    scheduledFor: dueAt,
    senderUserId: ownerUserId,
    earlierDraftIds: await sentDraftIds(step),
    approvalBy: required === PERSON_OR_MODE ? BY_MODE : BY_PERSON,
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

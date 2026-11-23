// A step's approval read at an instant (README.md "The approval mode", "The approval check"), in the
// caller's tenant run, with no cache: its campaign's effective mode, whether it is a first touch, by
// its version and by its enrollment's steps (review-gaps: a follow-up is a first touch until a step of
// its action in the enrollment has `succeeded`), and whose approval it needs (../steps/actions.ts). A
// campaign the workspace lacks reads as review_everything, and a version, an enrollment or a step it
// lacks as a first touch, each failing closed; a read that fails throws, never answering a follow-up.
// With `lock: "share"` (the queue's), the campaign's row is read FOR SHARE first, so a change of its
// mode waits for the caller's run, and the switch back that follows finds the item it opened.
import { tenantClient } from "@whytide/db";
import { currentTenant } from "@whytide/platform";
import { campaignByKey, versionSteps } from "../campaigns/reads.ts";
import { approvalRequired, type EnrolledStep, isFirstTouch } from "../steps/actions.ts";
import { type ApprovalMode, type ApprovalRequirement, REVIEW_EVERYTHING } from "./constants.ts";
import { effectiveMode } from "./mode.ts";

/**
 * A step as its approval is read: its own id and its enrollment's, its campaign and version, its key
 * and its action.
 */
export type RequirementStep = {
  readonly id: string;
  readonly enrollmentId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly stepKey: string;
  readonly actionType: string;
};
/** What the step needs at the instant, and why: the mode and whether it is a first touch. */
export type StepRequirement = {
  readonly mode: ApprovalMode;
  readonly firstTouch: boolean;
  readonly required: ApprovalRequirement;
};

/** The step's requirement at `at` (the file's header). */
export async function stepRequirement(
  step: RequirementStep,
  at: Date,
  options: { readonly lock?: "share" } = {},
): Promise<StepRequirement> {
  if (options.lock === "share") await shareCampaign(step.templateId);
  const campaign = await campaignByKey(step.templateId);
  const mode = campaign === null ? REVIEW_EVERYTHING : effectiveMode(campaign, at);
  const steps = await versionSteps(step.templateId, step.templateVersion);
  const enrolled = await enrollmentSteps(step.enrollmentId);
  const firstTouch = isFirstTouch(step, steps ?? [], enrolled);
  return { mode, firstTouch, required: approvalRequired({ ...step, firstTouch }, mode) };
}

/** The enrollment's steps, each its id, action and status; null for an enrollment not found. */
async function enrollmentSteps(enrollmentId: string): Promise<EnrolledStep[] | null> {
  // Prisma drops an undefined value from a where: unchecked, that would be any enrollment.
  if (typeof enrollmentId !== "string" || enrollmentId === "") return null;
  const enrollment = await tenantClient.enrollment.findFirst({
    where: { id: enrollmentId },
    select: { id: true },
  });
  if (enrollment === null) return null;
  return tenantClient.stepExecution.findMany({
    where: { enrollmentId },
    select: { id: true, actionType: true, status: true },
  });
}

/** The campaign's row, by its key_ref, held FOR SHARE until the caller's run ends. */
async function shareCampaign(keyRef: string): Promise<void> {
  const { workspaceId } = currentTenant();
  await tenantClient.$queryRaw`
    SELECT id FROM campaigns WHERE workspace_id = ${workspaceId} AND key_ref = ${keyRef} FOR SHARE`;
}

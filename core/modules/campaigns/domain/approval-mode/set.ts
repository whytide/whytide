// A campaign's approval mode changed (README.md "The approval mode", "Routes"; F13 §3.3), by the
// route's own runs. The first run locks the campaign (lockCampaign: its owner or campaigns.manage),
// refuses a mode this version lacks (approval_mode_unavailable) and review_first_touches before the
// lock ends (approval_mode_locked, with its end), and writes the mode with who and when, unless it is
// the campaign's already. review_everything is always taken, and then the switch back reads the
// campaign's steps whose latest item is the mode's, pending or approved by it: each goes back, in a
// run of its own, under the person's locks as every stop takes them (the lead, the enrollment, the
// step, then its items), to `planned` with no item, its mode's items blocked by approvals'
// returnModeItems, so the queue opens a new item for a person. A step the sender has claimed meets
// the gate, which refuses the mode's approval under review_everything (gate/approval.ts). Running
// the switch back on every review_everything, a repeat included, lets a call again finish one cut
// short; with nothing of the mode's left, a repeat changes nothing.
import { decisionsFor, returnModeItems, type StepDecision } from "@whytide/approvals";
import { lockLeadStatus } from "@whytide/contacts";
import { tenantClient, withTenant } from "@whytide/db";
import { AppError, currentTenant, type TenantContext } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { lockCampaign } from "../campaigns/commands.ts";
import { now } from "../clock.ts";
import { lockEnrollment } from "../steps/skip.ts";
import { givenClient } from "./client.ts";
import {
  type ApprovalMode,
  BY_MODE,
  MODE_ORIGIN,
  RETURNED_STEP_STATUSES,
  REVIEW_EVERYTHING,
} from "./constants.ts";
import { effectiveMode, isApprovalMode } from "./mode.ts";

/** What the route answers: the mode set, the mode in force now, and the end of the lock. */
export type ApprovalModeAnswer = {
  readonly mode: ApprovalMode;
  readonly effectiveMode: ApprovalMode;
  readonly lockedUntil: Date;
};
/** The first run's outcome: the answer, and the steps the switch back takes the mode from. */
export type ModeSet = { readonly answer: ApprovalModeAnswer; readonly returning: string[] };

/** A step back to `planned`: no item, no draft and no place, as a new step waits for the queue. */
const RETURNED = {
  status: "planned",
  approvalItemId: null,
  draftId: null,
  scheduledFor: null,
  quotaDay: null,
  errorCode: null,
} as const;

/** The mode set on the campaign, then the switch back, one run each (the file's header). */
export async function changeApprovalMode(
  tenant: TenantContext,
  campaignId: string,
  mode: unknown,
): Promise<ApprovalModeAnswer> {
  const { answer, returning } = await inRun(tenant, () => setApprovalMode(campaignId, mode));
  for (const stepExecutionId of returning)
    await inRun(tenant, () => returnModeStep(stepExecutionId));
  return answer;
}

/** The first run (the file's header), in the caller's tenant run. */
export async function setApprovalMode(campaignId: string, mode: unknown): Promise<ModeSet> {
  const campaign = await lockCampaign(campaignId);
  if (!isApprovalMode(mode)) throw new AppError(errors.approval_mode_unavailable);
  const at = now();
  const lockedUntil = campaign.reviewLockedUntil;
  const effective = effectiveMode({ approvalMode: mode, reviewLockedUntil: lockedUntil }, at);
  // Only review_everything is in force during the lock: any other mode waits for its end.
  if (effective !== mode) {
    const details = { lockedUntil: lockedUntil.toISOString() };
    throw new AppError(errors.approval_mode_locked, { details });
  }
  if (campaign.approvalMode !== mode) {
    const set = { approvalModeSetBy: currentTenant().principal.userId, approvalModeSetAt: at };
    await tenantClient.campaign.updateMany({
      where: { id: campaign.id },
      data: { approvalMode: mode, ...set },
    });
  }
  const returning = mode === REVIEW_EVERYTHING ? await modeSteps(campaign.keyRef) : [];
  return { answer: { mode, effectiveMode: effective, lockedUntil }, returning };
}

/**
 * One step of the switch back, in the caller's tenant run, under the locks every stop takes: the
 * lead, the enrollment, then the step, whose status is read under its lock. Whether it went back.
 */
export async function returnModeStep(stepExecutionId: string): Promise<boolean> {
  // Prisma drops an undefined value from a where: unchecked, that would be any step.
  if (typeof stepExecutionId !== "string" || stepExecutionId === "") return false;
  const step = await tenantClient.stepExecution.findFirst({
    where: { id: stepExecutionId },
    select: { id: true, personId: true, enrollmentId: true },
  });
  if (step === null) return false;
  await lockLeadStatus(step.personId);
  await lockEnrollment(tenantClient, step.enrollmentId);
  const status = await lockedStatus(step.id);
  if (!(RETURNED_STEP_STATUSES as readonly string[]).includes(status ?? "")) return false;
  const returned = await returnModeItems([step.id]);
  if (!returned.includes(step.id)) return false;
  const where = { id: step.id, status: status as (typeof RETURNED_STEP_STATUSES)[number] };
  const { count } = await tenantClient.stepExecution.updateMany({ where, data: RETURNED });
  return count === 1;
}

/** The campaign's steps whose latest item, their own, is the mode's: pending, or approved by it. */
async function modeSteps(keyRef: string): Promise<string[]> {
  const steps = await tenantClient.stepExecution.findMany({
    where: { templateId: keyRef, status: { in: [...RETURNED_STEP_STATUSES] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, approvalItemId: true },
  });
  const items = new Map(steps.map(({ id, approvalItemId }) => [id, approvalItemId]));
  const decisions = await decisionsFor(steps.map(({ id }) => id));
  return decisions
    .filter((latest) => items.get(latest.stepExecutionId) === latest.approvalItemId)
    .filter(isModes)
    .map(({ stepExecutionId }) => stepExecutionId);
}

/** An item opened for the mode and still pending, or one the mode approved. */
const isModes = (latest: StepDecision): boolean =>
  latest.approvalBy === BY_MODE &&
  (latest.status === "pending" ||
    (latest.status === "approved" && latest.decisionOrigin === MODE_ORIGIN));

/** The step's status, its row locked until the run ends; null for a step the workspace lacks. */
async function lockedStatus(stepExecutionId: string): Promise<string | null> {
  const { workspaceId } = currentTenant();
  const [row] = await tenantClient.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM step_executions
    WHERE workspace_id = ${workspaceId} AND id = ${stepExecutionId}
    FOR UPDATE`;
  return row?.status ?? null;
}

/** One run of the route's own, in the request's workspace as its principal. */
const inRun = <T>(tenant: TenantContext, fn: () => Promise<T>): Promise<T> =>
  withTenant(tenant, fn, { client: givenClient() });

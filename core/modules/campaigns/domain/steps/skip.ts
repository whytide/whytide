// A step skipped, and what follows it (README.md "The decision", "The approval check"; docs/flows.md
// "The decision"): the owner's skip in "Up next" (../decisions.ts) and the gate's approval block
// (../gate/gate.ts) end a step the same way, in the caller's transaction. The lead is locked first,
// then the enrollment, the steps and their items, the order the hold takes (README.md "The hold on
// reply"), so a skip and a reply's hold wait on each other rather than deadlock.
// Skipping the connection request ends the enrollment, since nothing else can follow it: the other
// pending steps cancelled with the reason, their items blocked, the enrollment exited (removed) and
// the lead finished. Skipping a message makes the next step due its delay after the skip, in business
// days in the sender's zone, unless linkedin no longer holds the account: nothing can go from it, so
// the next step gets no due time and the skip stands; after the last one, the enrollment is completed
// and the lead finished. A suppressed lead stays suppressed.
import { cancelItems } from "@whytide/approvals";
import { lockLeadStatus, recordLeadStatus, type StatusActor } from "@whytide/contacts";
import type { Prisma, TenantClient } from "@whytide/db";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import { currentTenant, isAppError } from "@whytide/platform";
import { PENDING_STEP_STATUSES } from "../gate/constants.ts";
import { nextDueAt } from "../template/due.ts";
import { checkedCode } from "./codes.ts";
import { STEP_REASON_CODES, type StepReasonCode } from "./constants.ts";

/** A step as a skip reads it: the skip is conditional on its status and its item as read. */
export type SkippedStep = {
  readonly id: string;
  readonly status: "awaiting_approval" | "scheduled" | "executing";
  readonly enrollmentId: string;
  readonly personId: string;
  readonly senderAccountId: string;
  readonly templateId: string;
  readonly position: number;
  readonly actionType: string;
  readonly approvalItemId: string | null;
};

/** The columns a skip reads, for a select. */
export const SKIPPED_STEP_FIELDS = {
  id: true,
  status: true,
  enrollmentId: true,
  personId: true,
  senderAccountId: true,
  templateId: true,
  position: true,
  actionType: true,
  approvalItemId: true,
} as const;

/** A skip: why, when, by whom, and what the gate saw when the gate skips. */
export type Skip = {
  readonly reason: StepReasonCode;
  /** The next step's delay counts from it, and an enrollment the skip ends ends at it. */
  readonly at: Date;
  /** The owner who skipped in "Up next", or the system for the gate's block. */
  readonly actor: StatusActor;
  readonly jitChecks?: Prisma.InputJsonObject;
};

/**
 * The step `skipped` with the reason, and the gate's checks when given, if it still has the status
 * and the item read; then what follows (the file's header). Whether it was skipped: a step that
 * moved meanwhile, held or cancelled by a stop, changes nothing.
 */
export async function skipStep(tx: TenantClient, step: SkippedStep, skip: Skip): Promise<boolean> {
  const reason = checkedCode(STEP_REASON_CODES, "skip_reason", skip.reason);
  await lockLeadStatus(step.personId);
  await lockEnrollment(tx, step.enrollmentId);
  const { count } = await tx.stepExecution.updateMany({
    where: { id: step.id, status: step.status, approvalItemId: step.approvalItemId },
    data: {
      status: "skipped",
      skipReason: reason,
      ...(skip.jitChecks !== undefined && { jitChecks: skip.jitChecks }),
    },
  });
  if (count === 0) return false;
  if (step.actionType === "invite") await endEnrollment(tx, step, { ...skip, reason });
  else await followMessage(tx, step, skip);
  return true;
}

/** The connection request skipped: nothing else can follow it, so the enrollment ends. */
async function endEnrollment(tx: TenantClient, step: SkippedStep, skip: Skip): Promise<void> {
  const others = { enrollmentId: step.enrollmentId, id: { not: step.id } };
  const cancelled = await tx.stepExecution.updateManyAndReturn({
    where: { ...others, status: { in: [...PENDING_STEP_STATUSES] } },
    data: { status: "cancelled", skipReason: skip.reason },
    select: { id: true },
  });
  // The pending items of the skipped and the cancelled steps, blocked in this transaction.
  await cancelItems([step.id, ...cancelled.map(({ id }) => id)]);
  const exited = { status: "exited", exitReason: "removed", endedAt: skip.at } as const;
  const where = { id: step.enrollmentId, status: "active" as const };
  const { count } = await tx.enrollment.updateMany({ where, data: exited });
  if (count === 1) await finishLead(step, skip.actor, "removed");
}

/** A message skipped: the next step due its delay after the skip, or, after the last, the end. */
async function followMessage(tx: TenantClient, step: SkippedStep, skip: Skip): Promise<void> {
  await cancelItems([step.id]);
  const [next] = await tx.stepExecution.findMany({
    where: { enrollmentId: step.enrollmentId, position: { gt: step.position } },
    select: { id: true, stepKey: true },
    orderBy: { position: "asc" },
    take: 1,
  });
  if (next === undefined) {
    const completed = { status: "completed", endedAt: skip.at } as const;
    const where = { id: step.enrollmentId, status: "active" as const };
    const { count } = await tx.enrollment.updateMany({ where, data: completed });
    if (count === 1) await finishLead(step, skip.actor);
    return;
  }
  const timeZone = await timeZoneOf(step.senderAccountId);
  // An account linkedin no longer holds: no due time, so a redelivery does not fail on it again.
  if (timeZone === null) return;
  const dueAt = nextDueAt(next.stepKey, skip.at, timeZone);
  if (dueAt === null) return;
  await tx.stepExecution.updateMany({ where: { id: next.id, status: "planned" }, data: { dueAt } });
}

/**
 * The lead `finished`, unless it has none or is suppressed: an entry or an opt-out outranks it. The
 * sender's settle finishes it too, after the last step (../send/settle.ts).
 */
export async function finishLead(
  step: Pick<SkippedStep, "personId" | "templateId">,
  actor: StatusActor,
  reason?: "removed",
) {
  const lead = await lockLeadStatus(step.personId);
  if (lead === null || lead === "suppressed") return;
  const { templateId } = step;
  await recordLeadStatus(step.personId, "finished", {
    ...(reason !== undefined && { reason }),
    templateId,
    actor,
  });
}

/** The account's zone; null when linkedin no longer holds the account in the run's workspace. */
export async function timeZoneOf(senderAccountId: string): Promise<string | null> {
  try {
    return (await findSenderAccount(senderAccountId)).timeZone;
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}

/** The enrollment's row, locked until the caller's transaction ends, after the lead's. */
export async function lockEnrollment(tx: TenantClient, enrollmentId: string): Promise<void> {
  const { workspaceId } = currentTenant();
  await tx.$queryRaw`
    SELECT id FROM enrollments WHERE workspace_id = ${workspaceId} AND id = ${enrollmentId}
    FOR UPDATE`;
}

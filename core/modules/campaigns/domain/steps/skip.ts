// A step skipped, and what follows it (README.md "The decision", "The approval check"; docs/flows.md
// "The decision"): the owner's skip in "Up next" (../decisions.ts) and the gate's approval block
// (../gate/gate.ts) end a step the same way, in the caller's transaction. The lead is locked first,
// then the enrollment, the steps and their items, the order the hold takes (README.md "The hold on
// reply"), so a skip and a reply's hold wait on each other rather than deadlock.
// Skipping the connection request ends the enrollment, since nothing else can follow it: the other
// pending steps cancelled with the reason, their items blocked, the enrollment exited (removed) and
// the lead finished. Skipping a message makes the next step due its delay in the enrollment's
// campaign version after the skip, in business days in the sender's zone, unless linkedin no longer
// holds the account: nothing can go from it, so the next step gets no due time and the skip stands;
// after the last one, the enrollment ends unless a step of it is still open (endIfDone). The email
// fallback's steps are a chain of their own after the LinkedIn steps (gamma-p3-060): a skipped
// fallback email makes the next fallback email due, in the enrollment's sender's zone, and leaves
// the LinkedIn steps as they are; a skipped LinkedIn message makes no fallback step due. A
// suppressed lead stays suppressed.
import { cancelItems } from "@whytide/approvals";
import { lockLeadStatus, recordLeadStatus, type StatusActor } from "@whytide/contacts";
import type { Prisma, TenantClient } from "@whytide/db";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import { currentTenant, isAppError } from "@whytide/platform";
import { versionSteps } from "../campaigns/reads.ts";
import { LIVE_ENROLLMENT_STATUSES, NO_PAUSE } from "../constants.ts";
import { fallbackKeys } from "../fallback/fallback.ts";
import { OPEN_STEP_STATUSES, PENDING_STEP_STATUSES } from "../gate/constants.ts";
import { nextDueAt } from "../template/due.ts";
import { inviteAcceptedAt } from "../withdraw/accepted.ts";
import { WITHDRAW_STEP_KEY, WITHDRAWN_STATUSES } from "../withdraw/constants.ts";
import { checkedCode } from "./codes.ts";
import { STEP_REASON_CODES, type StepReasonCode } from "./constants.ts";

/** A step as a skip reads it: the skip is conditional on its status and its item as read. */
export type SkippedStep = {
  readonly id: string;
  readonly status: "awaiting_approval" | "scheduled" | "executing";
  readonly enrollmentId: string;
  readonly personId: string;
  /** Set on every LinkedIn step; null on an email step, whose zone is its enrollment's sender's. */
  readonly senderAccountId: string | null;
  readonly stepKey: string;
  readonly templateId: string;
  readonly templateVersion: number;
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
  stepKey: true,
  templateId: true,
  templateVersion: true,
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
  else await followStep(tx, step, skip);
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
  const exited = {
    status: "exited",
    exitReason: "removed",
    endedAt: skip.at,
    ...NO_PAUSE,
  } as const;
  const where = { id: step.enrollmentId, status: { in: [...LIVE_ENROLLMENT_STATUSES] } };
  const { count } = await tx.enrollment.updateMany({ where, data: exited });
  if (count === 1) await finishLead(step, skip.actor, "removed");
}

/**
 * Another step skipped: the next step of its own chain due its delay after the skip (the fallback's
 * emails, or the LinkedIn steps), or, after the chain's last, the end unless a step is still open.
 */
async function followStep(tx: TenantClient, step: SkippedStep, skip: Skip): Promise<void> {
  await cancelItems([step.id]);
  const steps = (await versionSteps(step.templateId, step.templateVersion)) ?? [];
  const fallback = fallbackKeys(steps);
  const chain = fallback.includes(step.stepKey) ? { in: fallback } : { notIn: fallback };
  const [next] = await tx.stepExecution.findMany({
    where: { enrollmentId: step.enrollmentId, position: { gt: step.position }, stepKey: chain },
    select: { id: true, stepKey: true },
    orderBy: { position: "asc" },
    take: 1,
  });
  if (next === undefined) {
    await endIfDone(tx, step, skip.at, skip.actor);
    return;
  }
  const sender = step.senderAccountId ?? (await senderOf(tx, step));
  // An account linkedin no longer holds: no due time, so a redelivery does not fail on it again.
  const timeZone = sender === null ? null : await timeZoneOf(sender);
  if (timeZone === null) return;
  const dueAt = nextDueAt(next.stepKey, skip.at, timeZone, steps);
  if (dueAt === null) return;
  await tx.stepExecution.updateMany({ where: { id: next.id, status: "planned" }, data: { dueAt } });
}

/** The enrollment's sender account, whose zone an email step's delay counts in; null for none. */
async function senderOf(tx: TenantClient, step: SkippedStep): Promise<string | null> {
  const enrollment = await tx.enrollment.findFirst({
    where: { id: step.enrollmentId },
    select: { senderAccountId: true },
  });
  return enrollment?.senderAccountId ?? null;
}

/**
 * The live enrollment ended at `at` once no step of it is open (OPEN_STEP_STATUSES), under the
 * caller's locks on the lead and the enrollment: `exited` (`not_accepted`) when its connection
 * request was withdrawn and not accepted (README.md "Withdrawals"), `completed` otherwise, and the
 * lead finished. Whether it ended. A pending fallback email keeps it live (gamma-p3-060).
 */
export async function endIfDone(
  tx: TenantClient,
  step: Pick<SkippedStep, "enrollmentId" | "personId" | "templateId">,
  at: Date,
  actor: StatusActor,
): Promise<boolean> {
  const { enrollmentId } = step;
  const open = { enrollmentId, status: { in: [...OPEN_STEP_STATUSES] } };
  if ((await tx.stepExecution.count({ where: open })) > 0) return false;
  const withdrawal = { enrollmentId, stepKey: WITHDRAW_STEP_KEY };
  const withdrawn = { ...withdrawal, status: { in: [...WITHDRAWN_STATUSES] } };
  const notAccepted =
    (await tx.stepExecution.count({ where: withdrawn })) > 0 &&
    (await inviteAcceptedAt(enrollmentId)) === null;
  const data = notAccepted
    ? ({ status: "exited", exitReason: "not_accepted", endedAt: at, ...NO_PAUSE } as const)
    : ({ status: "completed", endedAt: at, ...NO_PAUSE } as const);
  const where = { id: enrollmentId, status: { in: [...LIVE_ENROLLMENT_STATUSES] } };
  const { count } = await tx.enrollment.updateMany({ where, data });
  if (count === 1) await finishLead(step, actor);
  return count === 1;
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

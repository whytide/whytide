// The just-in-time gate (README.md "The gate"; docs/flows.md "The gate"; architecture §14.2): right
// before a step is sent, campaigns' own sender (beta-p4-020) asks it once more, in its tenant run.
// Each check reads the database in that run, through contacts, linkedin and approvals, with no
// cache, so it sees an entry, a reply or a block committed a moment before (architecture §7.6). The
// first check that fails decides, and its block writes the outcome and the checks seen on the step;
// a pass writes nothing, and the sender stores the checks with its send. Only the sender calls it,
// so it may settle the step the sender claimed; a blocked step never reaches linkedin's reservation.
import { lastTouchAt, type Suppression, suppressionOf } from "@whytide/contacts";
import { type Prisma, tenantClient } from "@whytide/db";
import { findSenderAccount, lastInboundAt } from "@whytide/linkedin";
import { quotaDay } from "@whytide/platform";
import { holdForReply } from "../hold.ts";
import { needsApproval } from "../steps/actions.ts";
import { checkedCode } from "../steps/codes.ts";
import { STEP_REASON_CODES, type StepReasonCode } from "../steps/constants.ts";
import { SKIPPED_STEP_FIELDS, skipStep } from "../steps/skip.ts";
import { inviteAcceptedAt } from "../withdraw/accepted.ts";
import { type ApprovalSeen, checkApproval } from "./approval.ts";
import { GATE_STEP_STATUSES, type GateStepStatus, STEP_NOT_READY } from "./constants.ts";
import { requireInstant } from "./instant.ts";
import { exitSuppressed } from "./suppressed.ts";

/** What each check saw, in the gate's order, and the gate's instant: codes and instants only. */
export type GateChecks = {
  readonly at: string;
  readonly step: { readonly status: string | null };
  readonly enrollment?: { readonly status: string };
  readonly suppression?: Suppression;
  readonly reply?: { readonly lastInboundAt: string | null; readonly startedAt: string | null };
  readonly touch?: { readonly lastTouchAt: string | null; readonly quotaDay: string };
  /** Every step's but a withdrawal's: its item, the item's status and, on a pass, the hash. */
  readonly approval?: ApprovalSeen;
  /** A withdrawal's: when its connection request was accepted, if it was (beta-p4-060). */
  readonly invite?: { readonly acceptedAt: string | null };
};
export type GateReason = StepReasonCode | typeof STEP_NOT_READY;
export type GateAnswer =
  | { readonly pass: true; readonly checks: GateChecks }
  | { readonly pass: false; readonly reason: GateReason; readonly checks: GateChecks };

/** The step as the gate reads it: what a skip reads too (../steps/skip.ts). */
type Step = {
  readonly id: string;
  readonly status: GateStepStatus;
  readonly enrollmentId: string;
  readonly personId: string;
  readonly senderAccountId: string;
  readonly templateId: string;
  readonly position: number;
  readonly actionType: string;
  readonly approvalItemId: string | null;
};
/** What a block writes beside the reason and the checks: a new status, or the error code alone. */
type Outcome = { readonly status: "held" | "cancelled" | "skipped" } | { readonly status?: never };

/**
 * The gate's answer for the step at `at`: in this order, the step `scheduled` or `executing`
 * (`step_not_ready`, nothing written), the enrollment active (`enrollment_ended`), the person not
 * suppressed (the suppression's reason), no inbound message since the enrollment began (`replied`),
 * no touch on today's quota day in the sender's zone (`touched_today`), and, for a connection
 * request or a message, its owner's approval of the text it carries (`not_approved`,
 * `content_changed`: the step skipped, as an owner's skip is followed); for a withdrawal, its
 * connection request still not accepted (`invite_accepted`: the step cancelled, the enrollment on).
 */
export async function checkGate(
  stepExecutionId: string,
  options: { at: Date },
): Promise<GateAnswer> {
  const at = requireInstant(options?.at, "at");
  // Prisma drops an undefined value from a where: unchecked, that would be any step.
  const found =
    typeof stepExecutionId === "string" && stepExecutionId !== ""
      ? await tenantClient.stepExecution.findFirst({
          where: { id: stepExecutionId },
          select: SKIPPED_STEP_FIELDS,
        })
      : null;
  let checks: GateChecks = { at: at.toISOString(), step: { status: found?.status ?? null } };
  if (found === null || !isGateStatus(found.status)) {
    return { pass: false, reason: STEP_NOT_READY, checks };
  }
  const step: Step = { ...found, status: found.status };
  const { personId, senderAccountId } = step;

  const enrollment = await tenantClient.enrollment.findFirstOrThrow({
    where: { id: step.enrollmentId },
  });
  checks = { ...checks, enrollment: { status: enrollment.status } };
  if (enrollment.status !== "active") {
    const status = enrollment.status === "replied" ? "held" : "cancelled";
    return block(step, "enrollment_ended", checks, { status });
  }

  const suppression = await suppressionOf(personId, { newEnrollment: false });
  checks = { ...checks, suppression };
  if (suppression.suppressed) {
    const reason = checkedCode(STEP_REASON_CODES, "skip_reason", suppression.reason);
    await exitSuppressed(tenantClient, {
      ...{ enrollmentId: enrollment.id, personId, reason, at },
      keep: step.id,
    });
    return block(step, reason, checks, { status: "skipped" });
  }

  const inbound = await lastInboundAt(senderAccountId, personId);
  const { startedAt } = enrollment;
  checks = { ...checks, reply: { lastInboundAt: iso(inbound), startedAt: iso(startedAt) } };
  // An enrollment without a start counts every inbound message: the check fails closed.
  if (inbound !== null && (startedAt === null || inbound >= startedAt)) {
    await holdForReply(personId, { at });
    // The hold has already held this step when it was scheduled.
    return block(step, "replied", checks, { status: "held" }, "held");
  }

  const touched = await lastTouchAt(personId);
  const { timeZone } = await findSenderAccount(senderAccountId);
  const today = quotaDay(at, timeZone);
  checks = { ...checks, touch: { lastTouchAt: iso(touched), quotaDay: today } };
  // A touch dated after the gate's own day counts as today's: the check fails closed.
  if (touched !== null && quotaDay(touched, timeZone) >= today) {
    return block(step, "touched_today", checks, {});
  }

  // A withdrawal takes back a connection request nobody accepted (../withdraw/): one accepted since
  // the job opened it is cancelled, and its enrollment goes on (beta-p4-060).
  if (step.actionType === "withdraw") {
    const acceptedAt = await inviteAcceptedAt(step.enrollmentId);
    checks = { ...checks, invite: { acceptedAt: iso(acceptedAt) } };
    if (acceptedAt !== null) return block(step, "invite_accepted", checks, { status: "cancelled" });
  }
  // A withdrawal sends nothing to the person: it has no item and needs no approval. Any other
  // action needs its approved item, one the queue opens no item for included (steps/actions.ts).
  if (!needsApproval(step.actionType)) return { pass: true, checks };
  const approval = await checkApproval(step);
  checks = { ...checks, approval: approval.seen };
  if (!approval.pass) {
    const jitChecks = checks as Prisma.InputJsonObject;
    const skip = { reason: approval.reason, at, actor: SYSTEM, jitChecks };
    await skipStep(tenantClient, step, skip);
    return { pass: false, reason: approval.reason, checks };
  }
  return { pass: true, checks };
}

/**
 * Writes the block on the step, if it still has the status the gate read (or `also`): the outcome's
 * status with the reason in `skip_reason`, or the reason in `error_code` alone; and the checks.
 */
async function block(
  step: Step,
  reason: StepReasonCode,
  checks: GateChecks,
  outcome: Outcome,
  also?: "held",
): Promise<GateAnswer> {
  const field = outcome.status === undefined ? "error_code" : "skip_reason";
  const code = checkedCode(STEP_REASON_CODES, field, reason);
  const written =
    outcome.status === undefined
      ? { errorCode: code }
      : { status: outcome.status, skipReason: code };
  await tenantClient.stepExecution.updateMany({
    where: {
      id: step.id,
      status: { in: also === undefined ? [step.status] : [step.status, also] },
    },
    data: { ...written, jitChecks: checks as Prisma.InputJsonObject },
  });
  return { pass: false, reason: code, checks };
}

/** The gate's own skips are the system's. */
const SYSTEM = { type: "system" } as const;

function isGateStatus(status: string): status is GateStepStatus {
  return (GATE_STEP_STATUSES as readonly string[]).includes(status);
}

function iso(instant: Date | null): string | null {
  return instant === null ? null : instant.toISOString();
}

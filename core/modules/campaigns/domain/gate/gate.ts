// The just-in-time gate (README.md "The gate"; docs/flows.md "The gate"; architecture §14.2): right
// before a step is sent, campaigns' own sender (beta-p4-020) asks it once more, in its tenant run.
// Each check reads the database in that run, through contacts, linkedin and approvals, with no
// cache, so it sees an entry, a reply or a block committed a moment before (architecture §7.6). The
// first check that fails decides, and its block writes the outcome and the checks seen on the step;
// a pass writes nothing, and the sender stores the checks with its send. Only the sender calls it,
// so it may settle the step the sender claimed; a blocked step never reaches linkedin's
// reservation. gamma-p3-060: a fallback email whose connection request was accepted is skipped
// (../fallback/), and a step of a paused enrollment, or of a campaign that is not active, waits
// (../pause/). gamma-p4-050: an enrollment resumed after an out-of-office reply (../replies/) counts
// the replies after its resume only. gamma-p6-040: right after the enrollment's check, the step's
// sender's owner is an active member (../owner.ts), else the enrollment ends (owner_removed,
// ../no-sender.ts); an email step's mailbox is its enrollment's sender's owner's, else the step is
// skipped (sender_mismatch). gamma-p4-070: the approval check reads the campaign's effective mode at
// the gate's instant, and takes the mode's approval for a follow-up in review_first_touches only.
import { cancelItems } from "@whytide/approvals";
import { lastTouchAt, lockLeadStatus, type Suppression, suppressionOf } from "@whytide/contacts";
import { type Prisma, tenantClient } from "@whytide/db";
import { findMailbox } from "@whytide/email";
import { findSenderAccount, lastInboundAt } from "@whytide/linkedin";
import { quotaDay } from "@whytide/platform";
import { campaignByKey, versionSteps } from "../campaigns/reads.ts";
import { LIVE_ENROLLMENT_STATUSES } from "../constants.ts";
import { fallbackKeys, skipFallback } from "../fallback/fallback.ts";
import { holdForReply } from "../hold.ts";
import { endWithoutSender } from "../no-sender.ts";
import { accountOwnerOf, isActiveMember } from "../owner.ts";
import { campaignStatusOf } from "../pause/status.ts";
import { linkedinSenderAccount, needsApproval } from "../steps/actions.ts";
import { checkedCode } from "../steps/codes.ts";
import { STEP_REASON_CODES, type StepReasonCode } from "../steps/constants.ts";
import {
  endIfDone,
  lockEnrollment,
  SKIPPED_STEP_FIELDS,
  type SkippedStep,
  skipStep,
} from "../steps/skip.ts";
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
  /**
   * The step's sender's owner (gamma-p6-040): an active member, removed, or unknown (an account
   * linkedin no longer holds, whose later reads fail as before); and an email step's mailbox, its
   * enrollment's sender's owner's or another's.
   */
  readonly owner?: {
    readonly member: "active" | "removed" | "unknown";
    readonly mailbox?: "same_owner" | "other_owner";
  };
  readonly suppression?: Suppression;
  /** resumedAt only once a reply's hold was released (../replies/release-hold.ts). */
  readonly reply?: {
    readonly lastInboundAt: string | null;
    readonly startedAt: string | null;
    readonly resumedAt?: string;
  };
  /** The enrollment's campaign's status; null for a campaign the workspace lacks (gamma-p3-060). */
  readonly campaign?: { readonly status: string | null };
  readonly touch?: { readonly lastTouchAt: string | null; readonly quotaDay: string };
  /**
   * Every step's but a withdrawal's: its item, the item's status and, on a pass, the hash, the
   * campaign's effective mode, whether the step is a first touch and the approval's origin.
   */
  readonly approval?: ApprovalSeen;
  /** A withdrawal's and a fallback email's: when its connection request was accepted, if it was. */
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
  readonly stepKey: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly position: number;
  readonly actionType: string;
  readonly approvalItemId: string | null;
};
/** What a block writes beside the reason and the checks: a new status, or the error code alone. */
type Outcome = { readonly status: "held" | "cancelled" | "skipped" } | { readonly status?: never };
/** The enrollment as the owner's check reads it. */
type Enrollment = {
  readonly id: string;
  readonly personId: string;
  readonly templateId: string;
  readonly senderAccountId: string | null;
};

/**
 * The gate's answer for the step at `at`: in this order, the step `scheduled` or `executing`
 * (`step_not_ready`, nothing written), the enrollment live, active or paused (`enrollment_ended`),
 * the step's sender's owner an active member (`owner_removed`: the enrollment ended) and an email
 * step's mailbox its enrollment's sender's owner's (`sender_mismatch`: the step skipped),
 * for a fallback email its connection request not accepted (`invite_accepted`: the step skipped),
 * the person not suppressed (the suppression's reason), no inbound message since the enrollment
 * began or, once resumed after a reply's hold, since the resume (`replied`), the enrollment not
 * paused (`enrollment_paused`) and its campaign active (`campaign_not_active`), both waits, no touch
 * on today's quota day in the sender's zone (`touched_today`), and, for a connection request or a
 * message, its owner's approval of the text it carries (`not_approved`, `content_changed`: the step
 * skipped, as an owner's skip is followed); for a withdrawal, its connection request still not
 * accepted (`invite_accepted`: the step cancelled, the enrollment on).
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
          select: { ...SKIPPED_STEP_FIELDS, mailboxId: true },
        })
      : null;
  let checks: GateChecks = { at: at.toISOString(), step: { status: found?.status ?? null } };
  if (found === null || !isGateStatus(found.status)) {
    return { pass: false, reason: STEP_NOT_READY, checks };
  }
  const read = { ...found, status: found.status };

  const enrollment = await tenantClient.enrollment.findFirstOrThrow({
    where: { id: read.enrollmentId },
  });
  checks = { ...checks, enrollment: { status: enrollment.status } };
  if (!(LIVE_ENROLLMENT_STATUSES as readonly string[]).includes(enrollment.status)) {
    const status = enrollment.status === "replied" ? "held" : "cancelled";
    return block(read, "enrollment_ended", checks, { status });
  }
  // The sender's owner, read in this run (gamma-p6-040): a removed member's steps never go, on
  // either channel, whatever the subscriber to tenancy.member_removed has ended yet.
  const owner = await senderOwnerOf(read, enrollment);
  const member = owner === null ? "unknown" : (await isActiveMember(owner)) ? "active" : "removed";
  checks = { ...checks, owner: { member } };
  if (member === "removed") return endForRemovedOwner(read, enrollment, checks, at);
  if (read.actionType === "email" && read.mailboxId !== null) {
    // Fails closed: a mailbox the workspace lacks, or a sender's owner unknown, is another's.
    const mailbox = await findMailbox(read.mailboxId);
    const same = owner !== null && mailbox?.ownerUserId === owner;
    checks = { ...checks, owner: { member, mailbox: same ? "same_owner" : "other_owner" } };
    if (!same) return skipMismatch(read, checks, at);
  }
  // A fallback email goes only while its connection request is not accepted (../fallback/): one an
  // acceptance met after the queue is skipped here, its item blocked, as the acceptance skips it.
  if (read.actionType === "email") {
    const keys = fallbackKeys((await versionSteps(read.templateId, read.templateVersion)) ?? []);
    const acceptedAt = keys.includes(read.stepKey)
      ? await inviteAcceptedAt(read.enrollmentId)
      : null;
    if (acceptedAt !== null) {
      checks = { ...checks, invite: { acceptedAt: iso(acceptedAt) } };
      return skipAccepted(read, keys, checks, at);
    }
  }
  // Past the fallback, a LinkedIn step: an email step, which no LinkedIn sender claims, fails here.
  const step: Step = { ...read, senderAccountId: linkedinSenderAccount(found) };
  const { personId, senderAccountId } = step;

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
  const { startedAt, resumedAt } = enrollment;
  const reply = { lastInboundAt: iso(inbound), startedAt: iso(startedAt) };
  const resumed = resumedAt === null ? {} : { resumedAt: resumedAt.toISOString() };
  checks = { ...checks, reply: { ...reply, ...resumed } };
  // An enrollment without a start counts every inbound message: the check fails closed. One resumed
  // after a reply's hold counts the messages after the resume only: the out-of-office reply it was
  // resumed from holds it no more, and any later one does.
  const afterStart = inbound !== null && (startedAt === null || inbound >= startedAt);
  const afterResume = resumedAt === null || (inbound !== null && inbound > resumedAt);
  if (afterStart && afterResume) {
    await holdForReply(personId, { at });
    // The hold has already held this step when it was scheduled.
    return block(step, "replied", checks, { status: "held" }, "held");
  }

  // A pause (../pause/): the step keeps its status and waits, unplaced, for the resume.
  if (enrollment.status === "paused") return block(step, "enrollment_paused", checks, {});
  const campaign = await campaignStatusOf(enrollment.templateId);
  checks = { ...checks, campaign: { status: campaign } };
  if (campaign !== "active") return block(step, "campaign_not_active", checks, {});

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
    if (acceptedAt !== null) {
      // Under the locks every stop takes: a fallback skipped already may have left this step last.
      await lockLeadStatus(personId);
      await lockEnrollment(tenantClient, step.enrollmentId);
      const answer = await block(step, "invite_accepted", checks, { status: "cancelled" });
      await endIfDone(tenantClient, step, at, SYSTEM);
      return answer;
    }
  }
  // A withdrawal sends nothing to the person: it has no item and needs no approval. Any other
  // action needs its approved item, one the queue opens no item for included (steps/actions.ts).
  if (!needsApproval(step.actionType)) return { pass: true, checks };
  const approval = await checkApproval(step, at);
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
 * The owner of the step's sender: its account's for a LinkedIn step; for an email step its
 * enrollment's account's, else its campaign's (an enrollment without an account), whom its mailbox
 * must belong to. Null for none known: an account linkedin no longer holds, or no campaign row.
 */
async function senderOwnerOf(
  step: { readonly senderAccountId: string | null },
  enrollment: Enrollment,
): Promise<string | null> {
  const accountId = step.senderAccountId ?? enrollment.senderAccountId;
  if (accountId !== null) return accountOwnerOf(accountId);
  return (await campaignByKey(enrollment.templateId))?.ownerUserId ?? null;
}

/**
 * The step `cancelled` with owner_removed, under the locks every stop takes, if it still has the
 * status the gate read; then its enrollment ended, its other pending steps cancelled, their items
 * blocked and the lead finished (../no-sender.ts). Nothing is reserved: the gate comes first.
 */
async function endForRemovedOwner(
  step: Pick<Step, "id" | "status" | "personId">,
  enrollment: Enrollment,
  checks: GateChecks,
  at: Date,
): Promise<GateAnswer> {
  await lockLeadStatus(step.personId);
  await lockEnrollment(tenantClient, enrollment.id);
  const answer = await block(step, "owner_removed", checks, { status: "cancelled" });
  await endWithoutSender(tenantClient, enrollment, "owner_removed", at);
  return answer;
}

/**
 * The email step `skipped` with sender_mismatch, as the approval's block skips a step
 * (../steps/skip.ts): its item blocked, the next email due or the enrollment ended once nothing is
 * left; its LinkedIn steps go on.
 */
async function skipMismatch(step: SkippedStep, checks: GateChecks, at: Date): Promise<GateAnswer> {
  const jitChecks = checks as Prisma.InputJsonObject;
  await skipStep(tenantClient, step, { reason: "sender_mismatch", at, actor: SYSTEM, jitChecks });
  return { pass: false, reason: "sender_mismatch", checks };
}

/**
 * The fallback email skipped with invite_accepted, under the locks every stop takes, if it still
 * has the status the gate read, its item blocked; the enrollment's other pending fallback steps
 * too; then the enrollment ended if nothing is left of it. Its LinkedIn steps stay as they are.
 */
async function skipAccepted(
  step: Pick<Step, "id" | "status" | "enrollmentId" | "personId" | "templateId">,
  keys: readonly string[],
  checks: GateChecks,
  at: Date,
): Promise<GateAnswer> {
  await lockLeadStatus(step.personId);
  await lockEnrollment(tenantClient, step.enrollmentId);
  const answer = await block(step, "invite_accepted", checks, { status: "skipped" });
  await cancelItems([step.id]);
  await skipFallback(tenantClient, step.enrollmentId, keys);
  await endIfDone(tenantClient, step, at, SYSTEM);
  return answer;
}

/**
 * Writes the block on the step, if it still has the status the gate read (or `also`): the outcome's
 * status with the reason in `skip_reason`, or the reason in `error_code` alone; and the checks.
 */
async function block(
  step: Pick<Step, "id" | "status">,
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

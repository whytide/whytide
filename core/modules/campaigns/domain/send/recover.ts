// The recovery (beta-p4-040; README.md "Worker"; docs/flows.md "The check first", "The error map"),
// each in the caller's tenant run and conditional on the step still `executing`, so only the
// account's sender, one run at a time, settles its own steps: the steps due for their check, what a
// check answered, linkedin's error map (SEND_ERROR_MAP) applied to a port's error after the call,
// and a step late at the gate before the call. A step whose send may have gone out keeps its
// credits and waits for its next check: `due_at` on an `executing` step is when that check may run,
// null or past when due, so a failed check waits for the next quota day and an outage costs a check
// a day at most. A failed step ends its enrollment, locking the person's rows in the order every
// stop takes: the lead, the enrollment, the steps, then the items. A connection request refused as
// already connected is skipped, and its enrollment goes on (connected.ts, connect-already-connected).
import { cancelItems } from "@whytide/approvals";
import { lockLeadStatus } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import {
  findSendReservation,
  SEND_ERROR_MAP,
  type SendErrorMap,
  sendAnswerOf,
} from "@whytide/linkedin";
import { nextQuotaDayAt } from "@whytide/platform";
import { LIVE_ENROLLMENT_STATUSES, NO_PAUSE } from "../constants.ts";
import { PENDING_STEP_STATUSES } from "../gate/constants.ts";
import { lastExecutedAt } from "../plan/account.ts";
import { MIN_ACTION_GAP_MS } from "../plan/constants.ts";
import { linkedinSenderAccount } from "../steps/actions.ts";
import { checkedCode } from "../steps/codes.ts";
import { EXIT_DETAILS, STEP_REASON_CODES, type StepReasonCode } from "../steps/constants.ts";
import { finishLead, lockEnrollment, timeZoneOf } from "../steps/skip.ts";
import { skipConnected } from "./connected.ts";
import { MS_PER_SECOND, PORT_CODE_PREFIX } from "./constants.ts";
import { type Holds, releaseHolds, waitAgain } from "./release.ts";

/** What the settle answers (settle.ts Settled), here for the recovery's own outcomes. */
type Outcome = {
  readonly outcome: "sent" | "refused" | "kept";
  readonly end: boolean;
  readonly uncharged: null;
};
type SendEffect = SendErrorMap[keyof SendErrorMap];
/** A port's code the map has and the steps store; any other is linkedin_error_unmapped. */
type MappedCode = keyof SendErrorMap & StepReasonCode;
/** A step due for its check, with the credits its claim reserved. */
export type DueCheck = { readonly stepExecutionId: string; readonly usageId: string | null };

const SYSTEM = { type: "system" } as const;
/** Left `executing` with its holds: the run ends, the step waits for its check. */
const KEPT: Outcome = { outcome: "kept", end: true, uncharged: null };
const EXECUTING = { status: "executing" } as const;
const dueForCheck = (at: Date) => [{ dueAt: null }, { dueAt: { lte: at } }];

/** The account's `executing` steps due for their check at `at`, oldest first; none for an account gone. */
export async function dueChecks(accountId: string, at: Date): Promise<DueCheck[]> {
  if ((await timeZoneOf(accountId)) === null) return [];
  const rows = await tenantClient.stepExecution.findMany({
    where: { senderAccountId: accountId, ...EXECUTING, OR: dueForCheck(at) },
    orderBy: { id: "asc" },
    select: { id: true, creditUsageId: true },
  });
  return rows.map(({ id, creditUsageId }) => ({ stepExecutionId: id, usageId: creditUsageId }));
}

/** The sender accounts with an `executing` step due for its check at `at`: the plan starts them. */
export async function checkAccounts(at: Date): Promise<string[]> {
  const rows = await tenantClient.stepExecution.findMany({
    where: { ...EXECUTING, OR: dueForCheck(at) },
    distinct: ["senderAccountId"],
    select: { id: true, senderAccountId: true },
    orderBy: { senderAccountId: "asc" },
  });
  return rows.map(linkedinSenderAccount);
}

/**
 * The check at `at` found no send: linkedin released the slot; the credits are released and the
 * step goes back to `scheduled`, unplaced, with no code, for the plan (backToPlan). The next claim
 * raises `attempt`.
 */
export async function settleNotSent(id: string, holds: Holds, at: Date): Promise<Outcome> {
  await releaseHolds({ usageId: holds.usageId, reservationId: null });
  await backToPlan(id, null, at);
  return { outcome: "refused", end: false, uncharged: null };
}

/**
 * No call and no answer on the send: a check refused (its read, for the hours, a stop or the
 * account's `retry_at`), a check that failed at the provider (a port code), or the send activity's
 * own check before a retry, its slot kept. The step stays `executing` and waits for its next check:
 * the refusal's `retryAt`, or the next quota day's start in the sender's zone after a port's error or
 * with no time. The run ends.
 */
export async function deferCheck(
  id: string,
  refusal: { readonly refused: string; readonly retryAt: string | null },
  at: Date,
): Promise<Outcome> {
  const { refused, retryAt } = refusal;
  const dueAt =
    refused.startsWith(PORT_CODE_PREFIX) || retryAt === null
      ? await nextQuotaDayOf(id, at)
      : new Date(retryAt);
  await keepExecuting(id, refused, dueAt);
  return KEPT;
}

/**
 * A check's step whose request cannot be written again and that has no request file: no call was
 * made, as a send reads its file and an `executing` step keeps it (a crash before the file, or
 * beta-p4-030's read before an invite, whose claim takes the credits first). The credits are
 * released and the step goes back to `scheduled`, unplaced, waiting on `code` (backToPlan, at
 * `at`); a slot linkedin may hold for its key is taken again by its next claim or expires.
 */
export async function putBackUnsent(
  id: string,
  holds: Holds,
  code: StepReasonCode,
  at: Date,
): Promise<void> {
  await releaseHolds(holds);
  await backToPlan(id, code, at);
}

/**
 * The checked step back to `scheduled`, unplaced, waiting on `code`; due at `at` when it has no due
 * time, as one kept after an unknown outcome has none, so that the plan, which places due steps only,
 * places it again.
 */
async function backToPlan(id: string, code: StepReasonCode | null, at: Date): Promise<void> {
  if (!(await waitAgain({ id, ...EXECUTING }, code))) return;
  await tenantClient.stepExecution.updateMany({
    where: { id, status: "scheduled", dueAt: null },
    data: { dueAt: at },
  });
}

/**
 * A port's error after the call, `{ refused, reason?, retryAfterSec? }`, or a request off the port's
 * schema before it, by linkedin's error map; linkedin has already settled the slot and `retry_at`.
 * The outcome unknown: kept, checked at the next run after linkedin's pause. Otherwise the credits
 * are released and the step is `skipped` (a connection request refused as already connected, its
 * enrollment going on), `failed` (a send refused, a person not found, a defect), its enrollment
 * ended, or put back unplaced (`due_at` after the rate limit's wait, else the next quota day's
 * start). The run ends when the map's row touches the account.
 */
export async function settlePortError(
  id: string,
  holds: Holds,
  answer: {
    readonly refused: string;
    readonly reason?: string | undefined;
    readonly retryAfterSec?: number | undefined;
  },
  at: Date,
): Promise<Outcome> {
  const code = mappedCode(answer.refused);
  const effect: SendEffect = SEND_ERROR_MAP[await answerOf(id, code, answer.reason)];
  const { step } = effect;
  if (step.status === "executing" || step.status === "succeeded") {
    await keepExecuting(id, code, null);
    return KEPT;
  }
  await releaseHolds({ usageId: holds.usageId, reservationId: null });
  const end = effect.account !== null;
  if (step.status === "skipped") {
    await skipConnected(id, at);
    return { outcome: "refused", end, uncharged: null };
  }
  if (step.status === "failed") {
    await failStep(id, code, step.defect, at);
    return { outcome: "refused", end, uncharged: null };
  }
  const { retryAfterSec } = answer;
  const retryAt =
    step.notBefore !== "retry_after"
      ? await nextQuotaDayOf(id, at)
      : retryAfterSec === undefined
        ? null
        : new Date(at.getTime() + retryAfterSec * MS_PER_SECOND);
  await waitAgain({ id, ...EXECUTING }, code, retryAt);
  return { outcome: "refused", end, uncharged: null };
}

/**
 * The step `failed` with `code`, then its enrollment `exited` (`send_refused`; `exit_detail` the
 * code for a defect, and for a person without a LinkedIn profile, gamma-rf-050), its pending steps
 * `cancelled` with the code and their pending items blocked (approvals' cancelItems), and the lead
 * `finished` (the file's header). Whether it failed.
 */
export async function failStep(
  id: string,
  code: StepReasonCode,
  defect: boolean,
  at: Date,
): Promise<boolean> {
  const step = await tenantClient.stepExecution.findFirst({
    where: { id, ...EXECUTING },
    select: { enrollmentId: true, personId: true, templateId: true },
  });
  if (step === null) return false;
  const reason = checkedCode(STEP_REASON_CODES, "error_code", code);
  const exitDetail = defect ? checkedCode(EXIT_DETAILS, "exit_detail", code) : null;
  await lockLeadStatus(step.personId);
  await lockEnrollment(tenantClient, step.enrollmentId);
  const failed = await tenantClient.stepExecution.updateMany({
    where: { id, ...EXECUTING },
    data: { status: "failed", errorCode: reason },
  });
  if (failed.count === 0) return false;
  const exited = await tenantClient.enrollment.updateMany({
    where: { id: step.enrollmentId, status: { in: [...LIVE_ENROLLMENT_STATUSES] } },
    data: { status: "exited", exitReason: "send_refused", exitDetail, endedAt: at, ...NO_PAUSE },
  });
  const cancelled = await tenantClient.stepExecution.updateManyAndReturn({
    where: { enrollmentId: step.enrollmentId, status: { in: [...PENDING_STEP_STATUSES] } },
    data: { status: "cancelled", skipReason: reason },
    select: { id: true },
  });
  await cancelItems(cancelled.map((row) => row.id));
  if (exited.count === 1) await finishLead(step, SYSTEM);
  return true;
}

/**
 * At the gate before the call: a step more than MIN_ACTION_GAP_MS past the later of its time and its
 * slot's reservation, after a stop since its claim, has its holds freed and goes back to `scheduled`,
 * unplaced, for the plan. The slot's time counts for a connection request after its profile read
 * (beta-p4-030), whose slot is taken the read's wait after its time. Whether it was late.
 */
export async function putBackLate(id: string, holds: Holds, at: Date): Promise<boolean> {
  const step = await tenantClient.stepExecution.findFirst({
    where: { id, ...EXECUTING },
    select: { scheduledFor: true },
  });
  if (step === null) return false;
  const slot = holds.reservationId === null ? null : await findSendReservation(holds.reservationId);
  const since = Math.max(step.scheduledFor?.getTime() ?? 0, slot?.createdAt.getTime() ?? 0);
  if (since > 0 && at.getTime() - since <= MIN_ACTION_GAP_MS) return false;
  await releaseHolds(holds);
  await waitAgain({ id, ...EXECUTING }, null);
  return true;
}

/**
 * The account's last action for the sender's gap (next.ts): its latest send or, when later, the gate's
 * pass right before the call (`jit_checks.at`) of a step left `executing`, whose send may have gone
 * out. The plan counts sends only: it reads no `executing` step (beta-p4-010).
 */
export async function lastActionOf(accountId: string): Promise<Date | null> {
  let last = await lastExecutedAt(accountId);
  const rows = await tenantClient.stepExecution.findMany({
    where: { senderAccountId: accountId, ...EXECUTING },
    select: { jitChecks: true },
  });
  for (const { jitChecks } of rows) {
    const gated = gatedAt(jitChecks);
    if (gated !== null && (last === null || gated > last)) last = gated;
  }
  return last;
}

/** The gate's instant in a step's `jit_checks`, when it holds one. */
function gatedAt(checks: unknown): Date | null {
  const at = typeof checks === "object" && checks !== null && "at" in checks ? checks.at : null;
  const time = typeof at === "string" ? new Date(at) : null;
  return time === null || Number.isNaN(time.getTime()) ? null : time;
}

/** The step, still `executing`, waits for its check at `dueAt`, with the port's code when listed. */
async function keepExecuting(id: string, code: string | null, dueAt: Date | null): Promise<void> {
  const listed = code !== null && (STEP_REASON_CODES as readonly string[]).includes(code);
  await tenantClient.stepExecution.updateMany({
    where: { id, ...EXECUTING },
    data: { dueAt, ...(listed && { errorCode: code }) },
  });
}

/** The next quota day's start in the step's sender's zone; null for an account linkedin no longer holds. */
async function nextQuotaDayOf(id: string, at: Date): Promise<Date | null> {
  const step = await tenantClient.stepExecution.findFirst({
    where: { id },
    select: { id: true, senderAccountId: true },
  });
  const timeZone = step === null ? null : await timeZoneOf(linkedinSenderAccount(step));
  return timeZone === null ? null : nextQuotaDayAt(at, timeZone);
}

/** The map's key for a port's code; any other answer is an unmapped one, its outcome unknown. */
function mappedCode(code: string): MappedCode {
  const known =
    code.startsWith(PORT_CODE_PREFIX) &&
    Object.hasOwn(SEND_ERROR_MAP, code) &&
    (STEP_REASON_CODES as readonly string[]).includes(code);
  return (known ? code : "linkedin_error_unmapped") as MappedCode;
}

/**
 * The map's row for the step's answer: its code's, or, with a reason beside it, linkedin's key for
 * the code, the reason and the step's action (sendAnswerOf), so that only a connection request
 * refused as already connected has a row of its own.
 */
async function answerOf(
  id: string,
  code: MappedCode,
  reason: string | undefined,
): Promise<keyof SendErrorMap> {
  if (reason === undefined) return code;
  const step = await tenantClient.stepExecution.findFirst({
    where: { id },
    select: { actionType: true },
  });
  return sendAnswerOf(code, reason, step?.actionType);
}

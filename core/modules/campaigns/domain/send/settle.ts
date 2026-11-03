// The sender's settle (docs/flows.md "The sender", step 8), in one tenant run, on linkedin's answer.
// A send that went out: the credits committed first (credits takes the organization's lock first),
// then linkedin's slot; the step `succeeded` at `at`, its next step due by business days in the
// sender's zone, the touch recorded, campaigns.step_sent published once, and after the last step the
// enrollment completed and the lead finished. The person's rows are locked in the order every stop
// takes: the lead (only when the enrollment ends here), the enrollment, then the steps. A refusal
// before the call (its slot freed by linkedin) frees the credits and puts the step back to be placed
// again. beta-p4-040 (recover.ts): a check's answer, sent as a send that went out (linkedin
// committed the slot), not sent back to the plan; a refusal that kept the slot, or a check's, waits
// for the next check; a port's error by linkedin's error map, once ../withdraw/settle.ts has taken
// a withdrawal's invitation already gone (beta-p4-060). A step whose send may have gone out is
// never marked `failed`, which would free its key: only a send LinkedIn refused, or one never made.
import { errors as contactsErrors, lockLeadStatus, recordTouch } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { commitSend, findSendReservation } from "@whytide/linkedin";
import { credits, creditsCodes, currentTenant, isAppError, publish } from "@whytide/platform";
import { events } from "../../events.ts";
import { isSendRefusal } from "../steps/codes.ts";
import { finishLead, lockEnrollment, timeZoneOf } from "../steps/skip.ts";
import { nextDueAt } from "../template/due.ts";
import { settleGone, settleWithdrawn } from "../withdraw/settle.ts";
import { ACTION_REFUSALS, RUN_ENDING_REFUSALS } from "./constants.ts";
import { deferCheck, settleNotSent, settlePortError } from "./recover.ts";
import { type Holds, releaseHolds, waitAgain } from "./release.ts";

/** linkedin's answer of a send activity, as the workflow passes it on: ids, codes and instants. */
export type SendAnswer =
  | { readonly sent: true; readonly stepExecutionId: string }
  | { readonly refused: string; readonly retryAt: string | null }
  | { readonly refused: string; readonly retryAfterSec?: number }
  /** linkedin_check_sent's (beta-p4-040): whether a step left `executing` went out. */
  | { readonly outcome: "sent" | "not_sent"; readonly stepExecutionId: string };
export type Settled = {
  readonly outcome: "sent" | "refused" | "kept";
  /** Whether the run ends here. */
  readonly end: boolean;
  /** A send whose credits answered usage_not_open: its usage, logged as uncharged. */
  readonly uncharged: string | null;
};

const SYSTEM = { type: "system" } as const;
const STEP = {
  id: true,
  enrollmentId: true,
  personId: true,
  senderAccountId: true,
  templateId: true,
  position: true,
  actionType: true,
} as const;

/**
 * The claimed step settled on `answer` at `at` (the file's header); a check's has no reservation,
 * `reservationId` null.
 */
export async function settleSend(
  input: {
    readonly stepExecutionId: string;
    readonly holds: Holds;
    readonly answer: SendAnswer;
  },
  at: Date,
): Promise<Settled> {
  const { stepExecutionId: id, holds, answer } = input;
  if ("sent" in answer || ("outcome" in answer && answer.outcome === "sent"))
    return { ...(await settleSent(id, holds, at)), outcome: "sent", end: false };
  if ("outcome" in answer) return settleNotSent(id, holds, at);
  const { reservationId } = holds;
  // An answer with no retryAt came after the call: a withdrawal's invitation already gone, its step
  // `failed` and its enrollment ended, the run going on (../withdraw/settle.ts, beta-p4-060); else
  // a port's error, by the map.
  if (!("retryAt" in answer)) {
    if (reservationId !== null && (await settleGone(id, answer.refused, reservationId, at))) {
      return { outcome: "refused", end: false, uncharged: null };
    }
    return settlePortError(id, holds, answer, at);
  }
  // No call: a check's refusal, or the send activity's own check before a retry, its slot kept.
  const slot = reservationId === null ? null : await findSendReservation(reservationId);
  if (reservationId === null || slot?.status === "reserved") return deferCheck(id, answer, at);
  // A request file that is no send's (linkedin_input_invalid), or a code no refusal names: the map.
  if (!isSendRefusal(answer.refused)) return settlePortError(id, holds, answer, at);
  const retryAt = answer.retryAt === null ? null : new Date(answer.retryAt);
  await releaseHolds({ usageId: holds.usageId, reservationId: null });
  await waitAgain({ id, status: "executing" }, answer.refused, retryAt);
  return { outcome: "refused", end: endsRun(answer.refused, retryAt), uncharged: null };
}

/**
 * A refusal ends the run when it names no time, unless it is one action's (invites_paused: the
 * account's messages may still go, beta-p4-040), or when it is the account's rate limit.
 */
function endsRun(code: string, retryAt: Date | null): boolean {
  const action: readonly string[] = ACTION_REFUSALS;
  const ending: readonly string[] = RUN_ENDING_REFUSALS;
  return (retryAt === null && !action.includes(code)) || ending.includes(code);
}

/**
 * The send that went out, settled; the usage left uncharged, if credits no longer had it open. A
 * check's has no reservation: linkedin committed the slot when it found the send.
 */
async function settleSent(id: string, holds: Holds, at: Date) {
  const uncharged = await charge(holds.usageId);
  if (holds.reservationId !== null) await commitSend(holds.reservationId);
  const step = await tenantClient.stepExecution.findFirst({
    where: { id, status: "executing" },
    select: STEP,
  });
  // A step erased meanwhile: the holds settled, nothing else to write. A withdrawal ends its
  // enrollment rather than making a next step due (../withdraw/settle.ts, beta-p4-060).
  if (step?.actionType === "withdraw") await settleWithdrawn(step, at);
  else if (step !== null) await succeed(step, at);
  return { uncharged };
}

/** The usage committed; its id when credits answered usage_not_open (past its lease). */
async function charge(usageId: string | null): Promise<string | null> {
  if (usageId === null) return null;
  try {
    await credits.commit(usageId);
    return null;
  } catch (error) {
    if (isAppError(error) && error.code === creditsCodes.usage_not_open) return usageId;
    throw error;
  }
}

type SentStep = {
  readonly id: string;
  readonly enrollmentId: string;
  readonly personId: string;
  readonly senderAccountId: string;
  readonly templateId: string;
  readonly position: number;
  readonly actionType: "invite" | "message" | "withdraw";
};

/** The step `succeeded` and what follows it, under the locks the stops take (the file's header). */
async function succeed(step: SentStep, at: Date): Promise<void> {
  const next = await tenantClient.stepExecution.findFirst({
    where: { enrollmentId: step.enrollmentId, position: { gt: step.position } },
    orderBy: { position: "asc" },
    select: { id: true, stepKey: true },
  });
  if (next === null) await lockLeadStatus(step.personId);
  await lockEnrollment(tenantClient, step.enrollmentId);
  const { count } = await tenantClient.stepExecution.updateMany({
    where: { id: step.id, status: "executing" },
    data: { status: "succeeded", executedAt: at, errorCode: null },
  });
  if (count === 0) return;
  if (next !== null) await makeDue(step, next, at);
  await touch(step.personId, at);
  const { workspaceId } = currentTenant();
  const { id: stepExecutionId, personId, actionType } = step;
  const sent = events["campaigns.step_sent"];
  await publish(outboxWriter(tenantClient, workspaceId), sent, {
    stepExecutionId,
    personId,
    actionType,
  });
  if (next === null) await complete(step, at);
}

/**
 * The next step due its delay after the send, in business days in the sender's zone (follow_up_1
 * three after message_1, follow_up_2 five after follow_up_1), if still `planned`; message_1 waits for
 * the acceptance, and an account linkedin no longer holds gives none.
 */
async function makeDue(step: SentStep, next: { id: string; stepKey: string }, at: Date) {
  const timeZone = await timeZoneOf(step.senderAccountId);
  const dueAt = timeZone === null ? null : nextDueAt(next.stepKey, at, timeZone);
  if (dueAt === null) return;
  await tenantClient.stepExecution.updateMany({
    where: { id: next.id, status: "planned" },
    data: { dueAt },
  });
}

/** The touch on the person; one erased meanwhile has none to record. */
async function touch(personId: string, at: Date): Promise<void> {
  try {
    await recordTouch(personId, at);
  } catch (error) {
    if (!(isAppError(error) && error.code === contactsErrors.person_not_found)) throw error;
  }
}

/** After the last step: the enrollment completed, if still active, and the lead finished. */
async function complete(step: SentStep, at: Date): Promise<void> {
  const where = { id: step.enrollmentId, status: "active" } as const;
  const data = { status: "completed", endedAt: at } as const;
  const { count } = await tenantClient.enrollment.updateMany({ where, data });
  if (count === 1) await finishLead(step, SYSTEM);
}

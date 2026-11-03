// A claimed step that does not go (docs/flows.md "The sender"): its holds freed, in the caller's
// tenant run, and the step back to `scheduled` and unplaced, so the plan places it again, with the
// code it waits on and its due time moved to linkedin's retryAt when that is later. Every move is
// conditional on the status read, so a step a stop moved meanwhile is left as it is. A move notes
// the wait on the step's approved item, or clears it (item-wait.ts, beta-p4-040).
import { tenantClient } from "@whytide/db";
import { releaseSend } from "@whytide/linkedin";
import { credits } from "@whytide/platform";
import { checkedCode } from "../steps/codes.ts";
import { STEP_REASON_CODES, type StepReasonCode } from "../steps/constants.ts";
import { noteWait } from "./item-wait.ts";

/** What a claim holds: the credits (none for a withdrawal) and linkedin's slot (none yet). */
export type Holds = { readonly usageId: string | null; readonly reservationId: string | null };

/** The credits, then the slot, freed; a hold freed already changes nothing. */
export async function releaseHolds(holds: Holds): Promise<void> {
  if (holds.usageId !== null) await credits.release(holds.usageId);
  if (holds.reservationId !== null) await releaseSend(holds.reservationId);
}

/**
 * The step, if it still has `status` (and, for a placed one, its time), back to `scheduled` with no
 * time, no quota day and no credits, waiting on `code` (none: null), its due time moved to
 * `retryAt` when later. Whether it moved.
 */
export async function waitAgain(
  step: {
    readonly id: string;
    readonly status: "scheduled" | "executing";
    readonly scheduledFor?: Date;
  },
  code: StepReasonCode | null,
  retryAt: Date | null = null,
): Promise<boolean> {
  const errorCode = code === null ? null : checkedCode(STEP_REASON_CODES, "error_code", code);
  const where = {
    id: step.id,
    status: step.status,
    ...(step.scheduledFor !== undefined && { scheduledFor: placedAt(step.scheduledFor) }),
  };
  const row = await tenantClient.stepExecution.findFirst({ where, select: { dueAt: true } });
  if (row === null) return false;
  const later = retryAt !== null && (row.dueAt === null || retryAt > row.dueAt);
  const { count } = await tenantClient.stepExecution.updateMany({
    where,
    data: {
      status: "scheduled",
      scheduledFor: null,
      quotaDay: null,
      errorCode,
      creditUsageId: null,
      ...(later && { dueAt: retryAt }),
    },
  });
  if (count === 1) await noteWait(step.id, errorCode, retryAt);
  return count === 1;
}

/**
 * The condition on a step's time as `next` read it, an ISO instant: its millisecond, whatever finer
 * precision the column holds, so a claim never misses its own step.
 */
export const placedAt = (scheduledFor: Date) => ({
  gte: scheduledFor,
  lt: new Date(scheduledFor.getTime() + 1),
});

// The email fallback (README.md "The fallback"; docs/flows.md "The fallback"): the steps of an
// enrollment's campaign version marked with the condition, emails after its LinkedIn steps
// (../campaigns/sequence.ts, the fallback rule). The connection request's settle makes the first
// due FALLBACK_AFTER_DAYS calendar days after it went out (../send/settle.ts), a time the 15-minute
// jobs read, never a timer; an acceptance skips every pending one with invite_accepted, its item
// blocked, in the delivery's transaction (../acceptance.ts); the gate skips one an acceptance met
// between the queue and the claim (../gate/gate.ts). A skipped fallback step leaves the LinkedIn
// steps as they are, and the enrollment ends once no step of it is open (../steps/skip.ts
// endIfDone). Nothing here sends an email: until gamma-p4-010, a due email step waits `planned`.
import { cancelItems } from "@whytide/approvals";
import type { TenantClient } from "@whytide/db";
import { FALLBACK_CONDITION } from "../campaigns/constants.ts";
import type { VersionStep } from "../campaigns/sequence.ts";
import { MS_PER_DAY } from "../constants.ts";
import { PENDING_STEP_STATUSES } from "../gate/constants.ts";
import { checkedCode } from "../steps/codes.ts";
import { STEP_REASON_CODES, type StepReasonCode } from "../steps/constants.ts";

/** The keys of the version's fallback steps: those marked with the condition. */
export const fallbackKeys = (steps: readonly VersionStep[]): string[] =>
  steps.flatMap(({ stepKey, condition }) => (condition === FALLBACK_CONDITION ? [stepKey] : []));

/**
 * The connection request went out at `sentAt`: the version's step anchored on it, the fallback's
 * first, due its days later, while it is `planned` without a due time.
 */
export async function dueFallback(
  tx: TenantClient,
  enrollmentId: string,
  steps: readonly VersionStep[],
  sentAt: Date,
): Promise<void> {
  for (const { stepKey, delay } of steps) {
    if (delay.anchor !== "invite_sent") continue;
    const dueAt = new Date(sentAt.getTime() + delay.value * MS_PER_DAY);
    await tx.stepExecution.updateMany({
      where: { enrollmentId, stepKey, status: "planned", dueAt: null },
      data: { dueAt },
    });
  }
}

/**
 * The enrollment's pending fallback steps (`keys`) skipped with `reason`, invite_accepted unless
 * given (already_connected, connect-already-connected), their pending items blocked, in the caller's
 * transaction, under its locks on the lead and the enrollment; their ids.
 */
export async function skipFallback(
  tx: TenantClient,
  enrollmentId: string,
  keys: readonly string[],
  reason: StepReasonCode = "invite_accepted",
): Promise<string[]> {
  if (keys.length === 0) return [];
  const skipReason = checkedCode(STEP_REASON_CODES, "skip_reason", reason);
  const skipped = await tx.stepExecution.updateManyAndReturn({
    where: {
      enrollmentId,
      stepKey: { in: [...keys] },
      status: { in: [...PENDING_STEP_STATUSES] },
    },
    data: { status: "skipped", skipReason },
    select: { id: true },
  });
  const ids = skipped.map(({ id }) => id);
  await cancelItems(ids);
  return ids;
}

// The sender's claim (docs/flows.md "The sender", step 4), in one tenant run: the gate on the
// `scheduled` step, no more than a gap past its time; on a pass the claim, `executing` with the
// attempt raised, conditional on its status and on the time `next` read; the credits under
// `<idempotency_key>:<attempt>`, reserved only now, after the wait and the chat's read; then
// linkedin's slot under the step's own key. The gate runs before the claim, so a stop it makes takes
// the person's rows in the order every stop takes (lead, enrollment, steps, items) while this run
// holds no step row. A person with another step in flight waits (send_in_flight, beta-p4-040): that
// send's outcome is not known, so no touch is recorded for it. A refusal of the slot frees the
// credits in this run and puts the step back to be placed again; insufficient_credits rolls the
// whole run back, and waitForCredits records it in a run of its own. The claim clears the wait "Up
// next" showed. Before a profile read (beta-p4-030) the claim stops at the credits (chargeStep);
// after the read and its wait, claimSlot runs the gate again on the `executing` step and takes the
// slot, a block or a refusal freeing the credits.
import { approvedContent } from "@whytide/approvals";
import { tenantClient } from "@whytide/db";
import { reserveSend } from "@whytide/linkedin";
import { credits, currentTenant } from "@whytide/platform";
import { STEP_NOT_READY } from "../gate/constants.ts";
import { checkGate, type GateReason } from "../gate/gate.ts";
import { MIN_ACTION_GAP_MS } from "../plan/constants.ts";
import { isSendRefusal } from "../steps/codes.ts";
import { CHARGED_ACTIONS, LINKEDIN_SEND_ACTION, SEND_QUANTITY } from "./constants.ts";
import { blockClaimed } from "./gate.ts";
import { noteWait } from "./item-wait.ts";
import { placedAt, releaseHolds, waitAgain } from "./release.ts";

/** A placed step as `next` read it. */
export type Placed = { readonly stepExecutionId: string; readonly scheduledFor: Date };
/** linkedin's refusal of the chat's read before a message, which the claim records instead. */
export type ReadRefused = { readonly refused: string; readonly retryAt: string | null };
export type ClaimAnswer =
  | {
      readonly claimed: true;
      readonly reservationId: string;
      /** The credits' usage; null for a withdrawal, which costs nothing. */
      readonly usageId: string | null;
      readonly attempt: number;
    }
  | { readonly blocked: GateReason }
  | { readonly refused: string; readonly retryAt: string | null };
/** The claim's credits alone, before a profile read: the step `executing` and charged, no slot. */
export type ChargeAnswer =
  | { readonly charged: true; readonly usageId: string | null; readonly attempt: number }
  | { readonly blocked: GateReason }
  | { readonly refused: string; readonly retryAt: string | null };

const READ = {
  personId: true,
  senderAccountId: true,
  actionType: true,
  idempotencyKey: true,
  attempt: true,
} as const;

/** The step claimed at `at` with its holds, or why not (the file's header). */
export async function claimStep(placed: Placed, at: Date): Promise<ClaimAnswer> {
  const charged = await chargeStep(placed, at);
  return "charged" in charged ? takeSlot(placed.stepExecutionId, charged) : charged;
}

/** The gate, the claim and its credits at `at`, no slot yet; or why not (the file's header). */
export async function chargeStep(placed: Placed, at: Date): Promise<ChargeAnswer> {
  const { stepExecutionId: id, scheduledFor } = placed;
  // A step a gap past its time, after a slow read of the chat, is the plan's to place again.
  if (scheduledFor.getTime() < at.getTime() - MIN_ACTION_GAP_MS) return { blocked: STEP_NOT_READY };
  const where = { id, status: "scheduled", scheduledFor: placedAt(scheduledFor) } as const;
  const step = await tenantClient.stepExecution.findFirst({ where, select: READ });
  if (step === null) return { blocked: STEP_NOT_READY };
  const gate = await checkGate(id, { at });
  if (!gate.pass) {
    // touched_today writes its code alone: unplaced, the step waits for another day's plan.
    if (gate.reason === "touched_today") await waitAgain(placedStep(placed), gate.reason);
    return { blocked: gate.reason };
  }
  // The plan's touch rule reads no `executing` step (beta-p4-010): one in flight may have reached
  // the person today, an acceptance's message_1 included, so this one waits for another day's plan.
  if (await inFlight(step.personId, id)) {
    await waitAgain(placedStep(placed), "send_in_flight");
    return { blocked: "send_in_flight" };
  }
  const attempt = step.attempt + 1;
  const data = { status: "executing", attempt, errorCode: null } as const;
  if ((await tenantClient.stepExecution.updateMany({ where, data })).count === 0) {
    return { blocked: STEP_NOT_READY };
  }
  await noteWait(id, null, null);
  const { actionType, idempotencyKey } = step;
  let usageId: string | null = null;
  if ((CHARGED_ACTIONS as readonly string[]).includes(actionType)) {
    ({ usageId } = await credits.reserve({
      workspaceId: currentTenant().workspaceId,
      action: LINKEDIN_SEND_ACTION,
      quantity: SEND_QUANTITY,
      idempotencyKey: `${idempotencyKey}:${attempt}`,
      subjectRef: id,
      lease: "async",
    }));
    const claimed = { id, status: "executing" } as const;
    await tenantClient.stepExecution.updateMany({
      where: claimed,
      data: { creditUsageId: usageId },
    });
  }
  return { charged: true, usageId, attempt };
}

/**
 * The slot at `at` of a step claimed and charged before a profile read (the file's header): the gate
 * again on the `executing` step, then linkedin's slot. A block frees the credits as the gate right
 * before the call does; a refused slot frees them and puts the step back to wait.
 */
export async function claimSlot(
  id: string,
  usageId: string | null,
  at: Date,
): Promise<ClaimAnswer> {
  const holds = { usageId, reservationId: null };
  const where = { id, status: "executing" } as const;
  const step = await tenantClient.stepExecution.findFirst({ where, select: { attempt: true } });
  if (step === null) return { blocked: (await blockClaimed(id, holds, STEP_NOT_READY)).reason };
  const gate = await checkGate(id, { at });
  if (!gate.pass) return { blocked: (await blockClaimed(id, holds, gate.reason)).reason };
  return takeSlot(id, { usageId, attempt: step.attempt });
}

/** linkedin's slot of the claimed, charged step under its own key; refused, the credits freed. */
async function takeSlot(
  id: string,
  charged: { readonly usageId: string | null; readonly attempt: number },
): Promise<ClaimAnswer> {
  const claimed = { id, status: "executing" } as const;
  const step = await tenantClient.stepExecution.findFirstOrThrow({ where: claimed, select: READ });
  const { actionType, idempotencyKey } = step;
  const { usageId, attempt } = charged;
  // The month's notes are counted for an invite whose approved note is not empty.
  const withNote = actionType === "invite" && ((await approvedContent(id))?.text ?? "") !== "";
  const accountId = step.senderAccountId;
  const slot = await reserveSend({ accountId, actionType, idempotencyKey, withNote });
  if ("refused" in slot) {
    await releaseHolds({ usageId, reservationId: null });
    await waitAgain(claimed, slot.refused, slot.retryAt);
    return { refused: slot.refused, retryAt: slot.retryAt?.toISOString() ?? null };
  }
  return { claimed: true, reservationId: slot.reservationId, usageId, attempt };
}

/**
 * The claim's run rolled back for insufficient_credits: the step, still placed at the time read,
 * waits unplaced with the code, no credits and no slot held.
 */
export async function waitForCredits(placed: Placed): Promise<void> {
  await waitAgain(placedStep(placed), "insufficient_credits");
}

/**
 * The chat's read before a message refused: a refusal linkedin names a wait for is recorded on the
 * step, unplaced, its due time moved to the refusal's time, as a refused slot is; another (a port's
 * error) leaves the step placed, and the run ends (retryAt null).
 */
export async function readRefused(placed: Placed, refusal: ReadRefused): Promise<ClaimAnswer> {
  if (!isSendRefusal(refusal.refused)) return { refused: refusal.refused, retryAt: null };
  const retryAt = refusal.retryAt === null ? null : new Date(refusal.retryAt);
  await waitAgain(placedStep(placed), refusal.refused, retryAt);
  return refusal;
}

/** Whether another step of the person is `executing`: claimed, its outcome not settled yet. */
async function inFlight(personId: string, id: string): Promise<boolean> {
  const where = { personId, status: "executing", id: { not: id } } as const;
  return (await tenantClient.stepExecution.count({ where })) > 0;
}

const placedStep = ({ stepExecutionId, scheduledFor }: Placed) =>
  ({ id: stepExecutionId, status: "scheduled", scheduledFor }) as const;

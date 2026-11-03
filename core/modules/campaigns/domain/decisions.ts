// The owner's decision (README.md "The decision"; docs/flows.md "The decision"): the body of the
// subscriber to approvals.item_decided (events.ts), in the delivery's transaction. It acts only on a
// step still `awaiting_approval` whose item is the event's, and only on that item's stored status,
// read through approvals' decisionsFor, never on the payload alone, and only when it names who
// decided and when: approved, the step becomes `scheduled` with the item's draft; skipped, the step
// is skipped as its owner asked (steps/skip.ts). Anything else changes nothing: a redelivery, a
// decision that comes after a hold or a cancel, an item still pending or blocked.
import { decisionsFor, type StepDecision } from "@whytide/approvals";
import type { TenantClient } from "@whytide/db";
import { SKIPPED_STEP_FIELDS, type Skip, skipStep } from "./steps/skip.ts";

/** What a delivery did to the step. */
export type DecisionOutcome = "scheduled" | "skipped" | "unchanged";

/** approvals.item_decided as the subscriber reads it: ids only, never the decision itself. */
export type ItemDecided = { readonly approvalItemId: string; readonly stepExecutionId: string };

/** A stored decision for its step: approved with its draft, or skipped by whom and when. */
export type StoredDecision =
  | { readonly status: "approved"; readonly draftId: string | null }
  | { readonly status: "skipped"; readonly by: string; readonly at: Date };

/**
 * The step's latest item's decision, when that item is the event's, `approved` or `skipped`, with
 * who decided and when (approvals' CHECK keeps both on a decided row); null for anything else.
 */
export function storedDecision(
  latest: StepDecision | undefined,
  approvalItemId: string,
): StoredDecision | null {
  if (latest === undefined || latest.approvalItemId !== approvalItemId) return null;
  const { status, draftId, decidedBy, decidedAt } = latest;
  if (decidedBy === null || decidedAt === null) return null;
  if (status === "approved") return { status, draftId };
  if (status === "skipped") return { status, by: decidedBy, at: decidedAt };
  return null;
}

/** Applies the item's stored decision to its step (the file's header). */
export async function applyDecision(
  tx: TenantClient,
  decided: ItemDecided,
): Promise<DecisionOutcome> {
  const { approvalItemId, stepExecutionId } = decided;
  const step = await tx.stepExecution.findFirst({
    where: { id: stepExecutionId },
    select: SKIPPED_STEP_FIELDS,
  });
  if (step === null || step.status !== "awaiting_approval") return "unchanged";
  if (step.approvalItemId !== approvalItemId) return "unchanged";
  const [latest] = await decisionsFor([stepExecutionId]);
  const decision = storedDecision(latest, approvalItemId);
  if (decision === null) return "unchanged";
  if (decision.status === "approved") {
    const where = { id: step.id, status: "awaiting_approval" as const, approvalItemId };
    const data = { status: "scheduled" as const, draftId: decision.draftId };
    const { count } = await tx.stepExecution.updateMany({ where, data });
    return count === 1 ? "scheduled" : "unchanged";
  }
  const skip: Skip = {
    reason: "skipped_by_owner",
    at: decision.at,
    actor: { type: "user", id: decision.by },
  };
  const skipped = await skipStep(tx, { ...step, status: "awaiting_approval" }, skip);
  return skipped ? "skipped" : "unchanged";
}

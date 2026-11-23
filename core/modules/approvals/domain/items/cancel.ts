// cancelItems (README.md "Public interface"; docs/flows.md "A cancel"): campaigns' call, in its own
// transaction, whenever it holds, cancels or skips a step that has an open item, so a press in "Up
// next" after that finds the item decided (approval_item_not_pending). Only a `pending` item is
// blocked, the mode's `mode_declined` wait cleared with it; an approved, skipped or blocked one stays
// as it is. returnModeItems (gamma-p4-070): campaigns' call when a campaign goes back to "Review
// everything", in its run under the step's locks: the step's items opened for the mode, pending or
// approved by it, are blocked, the approval's hash, time and origin cleared as the CHECKs have a
// blocked item, and the approved one's draft is `ready` again through messaging, its AI disclosure
// line gone, so the queue opens a new item for a person, who approves the draft as any other.
import { tenantClient } from "@whytide/db";
import { reopenModeApproval } from "@whytide/messaging";
import { z } from "zod";
import { MODE_ORIGIN } from "./constants.ts";
import { id, parse } from "./store.ts";

/** Every pending item of the steps becomes `blocked`; the items blocked. approvals_input_invalid. */
export async function cancelItems(stepExecutionIds: readonly string[]): Promise<number> {
  const steps = [...new Set(parse(z.array(id), stepExecutionIds))];
  if (steps.length === 0) return 0;
  const where = { stepExecutionId: { in: steps }, status: "pending" as const };
  const { count } = await tenantClient.approvalItem.updateMany({
    where,
    data: { status: "blocked", waitCode: null, waitUntil: null },
  });
  return count;
}

/**
 * The mode taken back from the steps (the file's header): the steps whose item was blocked, each
 * once. A person's item, pending or decided, stays as it is. approvals_input_invalid; messaging's
 * refusal of a draft rolls the caller's run back.
 */
export async function returnModeItems(stepExecutionIds: readonly string[]): Promise<string[]> {
  const steps = [...new Set(parse(z.array(id), stepExecutionIds))];
  if (steps.length === 0) return [];
  const blocked = { status: "blocked" as const, waitCode: null, waitUntil: null };
  const pending = await tenantClient.approvalItem.updateManyAndReturn({
    where: { stepExecutionId: { in: steps }, status: "pending", approvalBy: "mode" },
    data: blocked,
    select: { stepExecutionId: true },
  });
  const approved = await tenantClient.approvalItem.updateManyAndReturn({
    where: { stepExecutionId: { in: steps }, status: "approved", decisionOrigin: MODE_ORIGIN },
    data: { ...blocked, approvedContentHash: null, decidedAt: null, decisionOrigin: null },
    select: { stepExecutionId: true, draftId: true },
  });
  for (const { stepExecutionId, draftId } of approved) {
    // Never null: the mode approves an item with its draft attached only (mode.ts).
    if (draftId !== null) await reopenModeApproval(draftId, { stepExecutionId });
  }
  return [...new Set([...pending, ...approved].map(({ stepExecutionId }) => stepExecutionId))];
}

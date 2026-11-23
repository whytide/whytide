// Approving by the campaign's mode (README.md "Approving by the mode"; docs/flows.md "The mode's
// approval"; gamma-p4-090), in the caller's tenant run, which messaging's freeze shares, so the
// frozen text, the approved item and approvals.item_decided commit together or not at all. An item
// opened for the mode (`approval_by = mode`) is approved by it once its draft is attached `ready`,
// only through messaging's approveStepDraftByMode, which ends the text with its channel's AI
// disclosure line before it freezes, so the approval's hash covers the line. The approval is the
// mode's, never a person's: origin `approval_mode`, no `decided_by`. Anything else leaves the item
// `pending` for a person, with the wait `mode_declined`: a connection request, a draft that is not
// `ready`, or one messaging refuses (draft_not_ready, disclosure_check_failed). The item is claimed
// first under a condition on `pending`, as a person's decision claims it, so the two cannot both
// win. Nothing here logs: messaging's refusal names gates only.
import { outboxWriter, tenantClient } from "@whytide/db";
import { approveStepDraftByMode, errors as messagingErrors, stepDrafts } from "@whytide/messaging";
import { currentTenant, isAppError, publish } from "@whytide/platform";
import { events } from "../../events.ts";
import { MODE_DECLINED, MODE_DRAFT_STATUS, MODE_ORIGIN } from "./constants.ts";
import { type Item, itemColumns } from "./store.ts";

/** messaging's refusals that leave the item to a person: the draft is not the mode's to approve. */
const DECLINED: readonly string[] = [
  messagingErrors.draft_not_ready,
  messagingErrors.disclosure_check_failed,
];

/** What the mode did: approved the item, left it to a person, or found no item of its own. */
export type ModeOutcome = "approved" | "declined" | "none";

/**
 * The mode's approval of the item, when it is pending, opened for the mode and its draft attached
 * (the file's header): `approved`, or `declined` with the item's wait `mode_declined`; `none` for any
 * other item, which changes nothing. messaging's other refusals and any fault roll the run back.
 */
export async function approveByMode(itemId: string): Promise<ModeOutcome> {
  const item = await claim(itemId);
  if (item === null || item.draftId === null) return "none";
  const [draft] = await stepDrafts([item.draftId]);
  // The mode never approves a connection request, nor a draft its writer did not leave ready.
  if (item.actionType === "invite" || draft?.status !== MODE_DRAFT_STATUS) return decline(item);
  let contentHash: string;
  try {
    const step = { stepExecutionId: item.stepExecutionId };
    ({ contentHash } = await approveStepDraftByMode(item.draftId, step));
  } catch (error) {
    if (isAppError(error) && DECLINED.includes(error.code)) return decline(item);
    throw error;
  }
  const decided = { decidedBy: null, decidedAt: new Date(), decisionOrigin: MODE_ORIGIN };
  const data = { ...decided, status: "approved" as const, approvedContentHash: contentHash };
  await decide(item, { ...data, waitCode: null, waitUntil: null });
  const outbox = outboxWriter(tenantClient, currentTenant().workspaceId);
  const payload = { approvalItemId: item.id, stepExecutionId: item.stepExecutionId };
  await publish(outbox, events["approvals.item_decided"], { ...payload, decision: "approved" });
  return "approved";
}

/** The item, if it is pending and opened for the mode, its row held for the decision; else null. */
async function claim(itemId: string): Promise<Item | null> {
  const where = { id: itemId, status: "pending" as const, approvalBy: "mode" as const };
  const data = { updatedAt: new Date() };
  const [item] = await tenantClient.approvalItem.updateManyAndReturn({
    where,
    data,
    select: itemColumns,
  });
  return item ?? null;
}

/** The claimed item left to a person: pending, with the wait that says the mode declined it. */
async function decline(item: Item): Promise<"declined"> {
  await decide(item, { waitCode: MODE_DECLINED, waitUntil: null });
  return "declined";
}

/** The claimed item's columns written while it is pending still: the claim holds its row. */
async function decide(item: Item, data: Record<string, unknown>): Promise<void> {
  const where = { id: item.id, status: "pending" as const };
  await tenantClient.approvalItem.updateMany({ where, data });
}

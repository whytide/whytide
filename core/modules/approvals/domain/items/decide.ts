// approve and skip (README.md "Routes"; docs/flows.md "An approval", "A skip"): the routes'
// commands, each in the request's tenant run, which messaging's freeze shares, so the frozen text,
// the decided item and approvals.item_decided commit together or not at all. Only a `pending` item
// is decided, once, and by the owner of its sender account alone: the item is claimed first under
// a condition on `pending`, which holds its row, so a decision pressed at the same moment waits on
// it and then finds the item decided. A hold or a cancel that blocked the item wins over a late
// press. Nothing here logs: messaging's refusal quotes the text's words in its details, which only
// the caller reads.
import { outboxWriter, tenantClient } from "@whytide/db";
import { approveStepDraft } from "@whytide/messaging";
import { AppError, currentTenant, type Principal, publish } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { APPROVAL_TEXT_MAX, DECISION_ORIGIN, type Decision } from "./constants.ts";
import { type Item, itemColumns, owns, parse, senderOf } from "./store.ts";

const approveInput = z.object({
  /** The owner's final text, `""` for a note left empty; absent, the draft's own. */
  text: z.string().max(APPROVAL_TEXT_MAX).optional(),
});
export type ApproveInput = z.input<typeof approveInput>;

/**
 * Approves the item with the text, the draft's own when none is given: messaging's
 * approveStepDraft checks and freezes it, and the item keeps the frozen text's hash.
 * approval_item_not_found, approval_item_not_pending, not_sender_owner, approval_draft_pending
 * while the draft is being written; messaging's draft_text_refused (400, the gates' issues) for a
 * text its gates refuse, a message's empty one included. The item, approved.
 */
export async function approve(
  itemId: string,
  input: ApproveInput,
  principal: Principal,
): Promise<Item> {
  const { text } = parse(approveInput, input);
  const item = await claim(itemId);
  await requireOwner(item, principal);
  if (item.draftId === null) throw new AppError(errors.approval_draft_pending);
  const freeze = { stepExecutionId: item.stepExecutionId, ...(text !== undefined && { text }) };
  const { contentHash } = await approveStepDraft(item.draftId, freeze);
  return decide(item, "approved", principal, { approvedContentHash: contentHash });
}

/**
 * Skips the item: the step goes no further, campaigns decides what follows (approvals.item_decided);
 * the draft stays as it is. approval_item_not_found, approval_item_not_pending, not_sender_owner.
 * The item, skipped.
 */
export async function skip(itemId: string, principal: Principal): Promise<Item> {
  const item = await claim(itemId);
  await requireOwner(item, principal);
  return decide(item, "skipped", principal, {});
}

/** The item, `pending`, its row held for the decision; approval_item_not_found or _not_pending. */
async function claim(itemId: string): Promise<Item> {
  // Prisma drops an undefined value from a where: unchecked, that would be any pending item.
  if (typeof itemId !== "string" || itemId === "") {
    throw new AppError(errors.approval_item_not_found);
  }
  const where = { id: itemId, status: "pending" as const };
  const data = { updatedAt: new Date() };
  const select = itemColumns;
  const [item] = await tenantClient.approvalItem.updateManyAndReturn({ where, data, select });
  if (item !== undefined) return item;
  const found = await tenantClient.approvalItem.findFirst({
    where: { id: itemId },
    select: { id: true },
  });
  const code = found === null ? errors.approval_item_not_found : errors.approval_item_not_pending;
  throw new AppError(code);
}

/** The principal owns the item's sender account, or not_sender_owner: no one else speaks through it. */
async function requireOwner(item: Item, principal: Principal): Promise<void> {
  const sender = await senderOf(item.senderAccountId);
  if (!owns(sender, principal.userId)) throw new AppError(errors.not_sender_owner);
}

/** The claimed item decided, and approvals.item_decided with ids and the decision only. */
async function decide(
  item: Item,
  decision: Decision,
  principal: Principal,
  columns: { readonly approvedContentHash?: string },
): Promise<Item> {
  const decided = { decidedBy: principal.userId, decidedAt: new Date() };
  const data = { ...columns, ...decided, status: decision, decisionOrigin: DECISION_ORIGIN };
  const where = { id: item.id, status: "pending" as const };
  const select = itemColumns;
  const [row] = await tenantClient.approvalItem.updateManyAndReturn({ where, data, select });
  // The claim holds the row: an item no longer pending here rolls the whole decision back.
  if (row === undefined) throw new AppError(errors.approval_item_not_pending);
  const outbox = outboxWriter(tenantClient, currentTenant().workspaceId);
  const { stepExecutionId } = item;
  const payload = { approvalItemId: item.id, stepExecutionId, decision };
  await publish(outbox, events["approvals.item_decided"], payload);
  return row;
}

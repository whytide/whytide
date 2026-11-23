// openItem and the draft's attach (README.md "Public interface"; docs/flows.md "An item opens", "The
// draft attached"), in the caller's tenant run. A step that can reach a person opens one `pending`
// item and asks messaging for its draft, written as its sender's owner: the LinkedIn account's, or
// the mailbox's for an email step (gamma-p4-090). The draft is attached once its writer ends it,
// `ready`, `flagged` or `failed`; until then the item reads as drafting. An item opened for the
// campaign's mode is approved by it as soon as its draft is attached (mode.ts), in the same run. A
// step's pending or approved item is answered as it is, so a second open, from a queue run
// overlapping another, changes nothing.
import { type TenantClient, tenantClient } from "@whytide/db";
import { requestStepDraft, stepDrafts } from "@whytide/messaging";
import { currentTenant, instant, newId } from "@whytide/platform";
import { z } from "zod";
import { ids } from "../../ids.ts";
import {
  ACTION_TYPES,
  APPROVAL_BY,
  DRAFT_ENDS,
  EMAIL_ACTION,
  STEP_KEY,
  WITHDRAW_STEP_KEY,
} from "./constants.ts";
import { approveByMode } from "./mode.ts";
import { type Item, id, itemColumns, parse } from "./store.ts";

/** A step key messaging writes a draft for; it refuses any other with messaging_input_invalid. */
type DraftStepKey = Parameters<typeof requestStepDraft>[0]["stepKey"];

const openItemInput = z
  .object({
    /** campaigns' `sx_` id of the step. */
    stepExecutionId: id,
    personId: id,
    /** linkedin's account the step goes out from: every step but an email. */
    senderAccountId: id.optional(),
    /** email's mailbox an email step goes out from, and no other step. */
    mailboxId: id.optional(),
    actionType: z.enum(ACTION_TYPES),
    /** A withdrawal sends nothing to the person and needs no approval. */
    stepKey: z
      .string()
      .regex(STEP_KEY)
      .refine((key) => key !== WITHDRAW_STEP_KEY),
    /** The step's due time. */
    scheduledFor: instant,
    /** The sender's owner, the account's or the mailbox's, as whom messaging writes the draft. */
    senderUserId: id,
    /** The same person's approved drafts of the sequence's earlier steps, oldest first. */
    earlierDraftIds: z.array(id).default([]),
    /** Who approves it: a person unless the campaign's mode may (gamma-p4-070 decides which). */
    approvalBy: z.enum(APPROVAL_BY).default("person"),
  })
  .superRefine(({ actionType, senderAccountId, mailboxId }, context) => {
    const email = actionType === EMAIL_ACTION;
    if (email !== (mailboxId !== undefined)) context.addIssue(issue("mailboxId"));
    if (email === (senderAccountId !== undefined)) context.addIssue(issue("senderAccountId"));
  });
export type OpenItemInput = z.input<typeof openItemInput>;

/** An issue on the field, as parse names it. */
const issue = (field: string) => ({ code: "custom" as const, path: [field], message: field });

/** Which steps an open answers with the item it has: one pending, or one approved, at most. */
const OPEN = { in: ["pending" as const, "approved" as const] };

/**
 * The step's item: its pending or approved one, unchanged, else a new `pending` one, with the
 * step's draft asked of messaging (requestStepDraft) and attached at once when its writer has ended
 * it already, as a re-opened step's is, and then, for the mode's item, approved by the mode or left
 * to a person (mode.ts). approvals_input_invalid for an input off its rule, a `withdraw` step, an
 * email without its mailbox and any other step without its account included; messaging's and
 * contacts' refusals as they are.
 */
export async function openItem(input: OpenItemInput): Promise<{ approvalItemId: string }> {
  const open = parse(openItemInput, input);
  const { stepExecutionId, personId, senderUserId, earlierDraftIds, mailboxId } = open;
  const held = await openOf(stepExecutionId);
  if (held !== null) return { approvalItemId: held };
  // messaging checks the key again: the cast only names its type.
  const stepKey = open.stepKey as DraftStepKey;
  const draft = { personId, stepExecutionId, stepKey, senderUserId, earlierDraftIds };
  const { draftId } = await requestStepDraft({ ...draft, ...(mailboxId && { mailboxId }) });
  const [written] = await stepDrafts([draftId]);
  const ended = written !== undefined && DRAFT_ENDS.includes(written.status);
  const approvalItemId = newId(ids.approval_item);
  const { workspaceId } = currentTenant();
  const { actionType, scheduledFor, approvalBy } = open;
  const sender = { senderAccountId: open.senderAccountId ?? null, mailboxId: mailboxId ?? null };
  const row = { id: approvalItemId, workspaceId, stepExecutionId, personId, ...sender };
  const step = { actionType, stepKey, scheduledFor, approvalBy };
  const data = { ...row, ...step, draftId: ended ? draftId : null };
  // The partial key: an open that lost a race writes nothing and answers the winner's.
  const { count } = await tenantClient.approvalItem.createMany({ data, skipDuplicates: true });
  if (count === 1) {
    if (ended && approvalBy === "mode") await approveByMode(approvalItemId);
    return { approvalItemId };
  }
  const where = { stepExecutionId, status: OPEN };
  const winner = await tenantClient.approvalItem.findFirstOrThrow({ where, select: { id: true } });
  return { approvalItemId: winner.id };
}

/**
 * messaging.step_draft_ready's work (events.ts), in the delivery's transaction: the step's pending
 * item with no draft gets the draft, and an item opened for the mode is then approved by it or
 * left to a person (mode.ts). Anything else changes nothing: a redelivery, an item blocked or
 * decided meanwhile, a draft attached at the open. The items changed, 0 or 1.
 */
export async function draftEnded(
  tx: Pick<TenantClient, "approvalItem">,
  ended: { readonly draftId: string; readonly stepExecutionId: string },
): Promise<number> {
  const attached = await attachDraft(tx, ended);
  if (attached === null) return 0;
  if (attached.approvalBy === "mode") await approveByMode(attached.id);
  return 1;
}

/** The step's pending item with no draft, given the draft: the item, or null when none was. */
async function attachDraft(
  tx: Pick<TenantClient, "approvalItem">,
  ended: { readonly draftId: string; readonly stepExecutionId: string },
): Promise<Item | null> {
  const where = {
    stepExecutionId: ended.stepExecutionId,
    status: "pending" as const,
    draftId: null,
  };
  const data = { draftId: ended.draftId };
  const [item] = await tx.approvalItem.updateManyAndReturn({ where, data, select: itemColumns });
  return item ?? null;
}

/** The id of the step's pending or approved item in this workspace, or null. */
async function openOf(stepExecutionId: string): Promise<string | null> {
  const where = { stepExecutionId, status: OPEN };
  const item = await tenantClient.approvalItem.findFirst({ where, select: { id: true } });
  return item?.id ?? null;
}

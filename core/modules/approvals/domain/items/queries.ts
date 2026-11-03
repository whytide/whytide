// approvals' public queries (README.md "Public interface"), each in the caller's tenant run, with no
// cache, so a decision, a block or a changed text committed a moment earlier is seen:
// approvedContent, which the send's gate compares with what it carries (beta-p3-050), the latest
// item of each step, the edit report and the days with decisions.
import { tenantClient } from "@whytide/db";
import { approvedContent as frozenContent, stepDrafts } from "@whytide/messaging";
import { instant } from "@whytide/platform";
import { z } from "zod";
import { DECISIONS, type ItemStatus } from "./constants.ts";
import { countEdits, type DecisionDay, daysOf, type EditStats } from "./rules.ts";
import { type Item, id, itemColumns, owns, parse, senderOf, sendersOf, zoneOf } from "./store.ts";

/** What the owner approved for a step: the frozen text, its hash, and who approved it when. */
export type ApprovedStep = {
  readonly text: string;
  readonly contentHash: string;
  readonly approvalItemId: string;
  readonly approvedBy: string;
  readonly approvedAt: Date;
};
/** A step's latest item, as campaigns reads its decision (beta-p3-050). */
export type StepDecision = {
  readonly stepExecutionId: string;
  readonly approvalItemId: string;
  readonly status: ItemStatus;
  readonly draftId: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
};

const sinceInput = z.object({ since: instant });

/**
 * The step's approved text, only when its item is `approved`, by the owner of its sender account,
 * and messaging's frozen text (approvedContent) still hashes to the hash the approval kept; null
 * otherwise: a pending, skipped or blocked item, or a text changed behind approvals' back.
 */
export async function approvedContent(stepExecutionId: string): Promise<ApprovedStep | null> {
  // Prisma drops an undefined value from a where: unchecked, that would be any step's item.
  if (typeof stepExecutionId !== "string" || stepExecutionId === "") return null;
  const where = { stepExecutionId, status: "approved" as const };
  const item = await tenantClient.approvalItem.findFirst({ where, select: itemColumns });
  if (item === null) return null;
  const { draftId, approvedContentHash, decidedBy, decidedAt } = item;
  if (draftId === null || approvedContentHash === null) return null;
  if (decidedBy === null || decidedAt === null) return null;
  if (!owns(await senderOf(item.senderAccountId), decidedBy)) return null;
  const frozen = await frozenContent(draftId);
  if (frozen === null || frozen.contentHash !== approvedContentHash) return null;
  const { text, contentHash } = frozen;
  return {
    text,
    contentHash,
    approvalItemId: item.id,
    approvedBy: decidedBy,
    approvedAt: decidedAt,
  };
}

/** Each step's latest item, in the order of the ids, each once; a step with none is left out. */
export async function decisionsFor(stepExecutionIds: readonly string[]): Promise<StepDecision[]> {
  const steps = [...new Set(parse(z.array(id), stepExecutionIds))];
  if (steps.length === 0) return [];
  const rows = await tenantClient.approvalItem.findMany({
    where: { stepExecutionId: { in: steps } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: itemColumns,
  });
  const latest = new Map<string, Item>();
  for (const row of rows)
    if (!latest.has(row.stepExecutionId)) latest.set(row.stepExecutionId, row);
  return steps.flatMap((stepExecutionId) => {
    const item = latest.get(stepExecutionId);
    if (item === undefined) return [];
    const { id: approvalItemId, status, draftId, decidedBy, decidedAt } = item;
    return [{ stepExecutionId, approvalItemId, status, draftId, decidedBy, decidedAt }];
  });
}

/**
 * The items approved since `since`, read through messaging's stepDrafts: how many, how many
 * unedited, how many with a small edit (rules.ts countEdits). approvals_input_invalid.
 */
export async function editStats(input: { readonly since: Date | string }): Promise<EditStats> {
  const { since } = parse(sinceInput, input);
  const where = { status: "approved" as const, decidedAt: { gte: since } };
  const select = { actionType: true, draftId: true } as const;
  const rows = await tenantClient.approvalItem.findMany({ where, select });
  const draftIds = rows.flatMap(({ draftId }) => (draftId === null ? [] : [draftId]));
  const drafts = new Map((await stepDrafts(draftIds)).map((draft) => [draft.id, draft]));
  const approvals = rows.flatMap(({ actionType, draftId }) => {
    const draft = draftId === null ? undefined : drafts.get(draftId);
    if (draft === undefined) return [];
    const { text, editedByUser, editRatio } = draft;
    return [{ actionType, text, editedByUser, editRatio }];
  });
  return countEdits(approvals);
}

/**
 * The local days, in each sender's zone, with at least one decision since `since`, approved or
 * skipped, by sender then day. approvals_input_invalid.
 */
export async function decisionDays(input: {
  readonly since: Date | string;
}): Promise<DecisionDay[]> {
  const { since } = parse(sinceInput, input);
  const where = { status: { in: [...DECISIONS] }, decidedAt: { gte: since } };
  const select = { senderAccountId: true, decidedAt: true } as const;
  const rows = await tenantClient.approvalItem.findMany({ where, select });
  const senders = await sendersOf(rows.map(({ senderAccountId }) => senderAccountId));
  return daysOf(rows, (senderAccountId) => zoneOf(senders.get(senderAccountId)));
}

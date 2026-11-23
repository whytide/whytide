// approvals' public queries (README.md "Public interface"), each in the caller's tenant run, with no
// cache, so a decision, a block or a changed text committed a moment earlier is seen:
// approvedContent, which the send's gate compares with what it carries (beta-p3-050), a person's
// approval only unless the caller asks for the mode's too (gamma-p4-090), the latest item of each
// step, the edit report and the days with decisions, both of a person's decisions only.
import { tenantClient } from "@whytide/db";
import { approvedContent as frozenContent, stepDrafts } from "@whytide/messaging";
import { instant } from "@whytide/platform";
import { z } from "zod";
import {
  type ApprovalBy,
  DECISION_ORIGIN,
  DECISIONS,
  type DecisionOrigin,
  type ItemStatus,
  MODE_ORIGIN,
} from "./constants.ts";
import { countEdits, type DecisionDay, daysOf, type EditStats } from "./rules.ts";
import {
  type Item,
  id,
  itemColumns,
  owns,
  parse,
  senderIdOf,
  senderOf,
  sendersOf,
  zoneOf,
} from "./store.ts";

/**
 * What a person approved for a step, the owner of its sender: the frozen text, an email's frozen
 * subject (null for a follow-up; absent on LinkedIn, as messaging answers it), its hash, and who
 * approved it when. The answer a caller gets unless it asks with `allowMode`.
 */
export type ApprovedStep = {
  readonly text: string;
  readonly subject?: string | null;
  readonly contentHash: string;
  readonly approvalItemId: string;
  readonly approvedBy: string;
  readonly approvedAt: Date;
};
/**
 * The answer to a caller that asks with `allowMode`: a person's approval, origin `app`, or, when
 * `allowMode` is true, the campaign's mode's, origin `approval_mode`, which no person made and whose
 * text ends with its channel's AI disclosure line (`disclosureApplied`).
 */
export type ApprovedStepWithOrigin =
  | (ApprovedStep & { readonly origin: typeof DECISION_ORIGIN; readonly disclosureApplied: false })
  | (Omit<ApprovedStep, "approvedBy"> & {
      readonly approvedBy: null;
      readonly origin: typeof MODE_ORIGIN;
      readonly disclosureApplied: true;
    });
/** Whether the caller takes the campaign's mode's approval as an approval too. */
export type ApprovedContentOptions = { readonly allowMode: boolean };
/**
 * A step's latest item, as campaigns reads its decision (beta-p3-050): who it was opened for and
 * where its decision came from too, the mode's approval naming no person (gamma-p4-070).
 */
export type StepDecision = {
  readonly stepExecutionId: string;
  readonly approvalItemId: string;
  readonly status: ItemStatus;
  readonly draftId: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly approvalBy: ApprovalBy;
  readonly decisionOrigin: DecisionOrigin | null;
};

const sinceInput = z.object({ since: instant });

/**
 * The step's approved content, only when its item is `approved` by the owner of its sender, the
 * LinkedIn account's or the mailbox's, or, with `allowMode: true`, by the campaign's mode, and
 * messaging's frozen content (approvedContent) still hashes to the hash the approval kept; null
 * otherwise: a pending, skipped or blocked item, the mode's approval without `allowMode`, or a text
 * or a subject changed behind approvals' back. Asked with `allowMode`, the answer adds its origin
 * and `disclosureApplied`.
 */
export function approvedContent(stepExecutionId: string): Promise<ApprovedStep | null>;
export function approvedContent(
  stepExecutionId: string,
  options: ApprovedContentOptions,
): Promise<ApprovedStepWithOrigin | null>;
export async function approvedContent(
  stepExecutionId: string,
  options?: ApprovedContentOptions,
): Promise<ApprovedStep | ApprovedStepWithOrigin | null> {
  // Prisma drops an undefined value from a where: unchecked, that would be any step's item.
  if (typeof stepExecutionId !== "string" || stepExecutionId === "") return null;
  const where = { stepExecutionId, status: "approved" as const };
  const item = await tenantClient.approvalItem.findFirst({ where, select: itemColumns });
  if (item === null || item.draftId === null || item.approvedContentHash === null) return null;
  const decision = await decisionOf(item, options?.allowMode === true);
  if (decision === null) return null;
  const frozen = await frozenContent(item.draftId);
  if (frozen === null || frozen.contentHash !== item.approvedContentHash) return null;
  const { text, contentHash, disclosureApplied } = frozen;
  const content = {
    text,
    ...(frozen.subject !== undefined && { subject: frozen.subject }),
    contentHash,
    approvalItemId: item.id,
    approvedAt: decision.approvedAt,
  };
  // The mode's approval always carries the line, a person's never (messaging's two paths).
  if (decision.origin === MODE_ORIGIN) {
    if (!disclosureApplied) return null;
    return { ...content, approvedBy: null, origin: MODE_ORIGIN, disclosureApplied };
  }
  if (disclosureApplied) return null;
  const person = { ...content, approvedBy: decision.approvedBy };
  return options === undefined ? person : { ...person, origin: DECISION_ORIGIN, disclosureApplied };
}

/** Who approved the approved item and when, as the caller may take it; null when it may not. */
async function decisionOf(
  item: Item,
  allowMode: boolean,
): Promise<
  | {
      readonly origin: typeof DECISION_ORIGIN;
      readonly approvedBy: string;
      readonly approvedAt: Date;
    }
  | { readonly origin: typeof MODE_ORIGIN; readonly approvedBy: null; readonly approvedAt: Date }
  | null
> {
  const { decisionOrigin, decidedBy, decidedAt: approvedAt } = item;
  if (approvedAt === null) return null;
  if (decisionOrigin === MODE_ORIGIN) {
    // The mode's own: no person, on an item opened for it (the CHECK), and only when asked for.
    if (!allowMode || decidedBy !== null || item.approvalBy !== "mode") return null;
    return { origin: MODE_ORIGIN, approvedBy: null, approvedAt };
  }
  if (decisionOrigin !== DECISION_ORIGIN || decidedBy === null) return null;
  if (!owns(await senderOf(item), decidedBy)) return null;
  return { origin: DECISION_ORIGIN, approvedBy: decidedBy, approvedAt };
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
    const { approvalBy, decisionOrigin } = item;
    const decided = { draftId, decidedBy, decidedAt, approvalBy, decisionOrigin };
    return [{ stepExecutionId, approvalItemId, status, ...decided }];
  });
}

/**
 * The items a person approved since `since`, read through messaging's stepDrafts: how many, how
 * many unedited, how many with a small edit (rules.ts countEdits); the mode's approvals are left
 * out, so the shares measure people. approvals_input_invalid.
 */
export async function editStats(input: { readonly since: Date | string }): Promise<EditStats> {
  const { since } = parse(sinceInput, input);
  const where = {
    status: "approved" as const,
    decisionOrigin: DECISION_ORIGIN,
    decidedAt: { gte: since },
  };
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
 * The local days, in each sender's zone, with at least one decision by a person since `since`,
 * approved or skipped, by sender then day; an email item's sender is its mailbox. The mode's
 * approvals are left out. approvals_input_invalid.
 */
export async function decisionDays(input: {
  readonly since: Date | string;
}): Promise<DecisionDay[]> {
  const { since } = parse(sinceInput, input);
  const where = {
    status: { in: [...DECISIONS] },
    decisionOrigin: DECISION_ORIGIN,
    decidedAt: { gte: since },
  };
  const select = { senderAccountId: true, mailboxId: true, decidedAt: true } as const;
  const rows = await tenantClient.approvalItem.findMany({ where, select });
  const senders = await sendersOf(rows);
  const decided = rows.map((row) => ({
    senderAccountId: senderIdOf(row),
    decidedAt: row.decidedAt,
  }));
  return daysOf(decided, (senderId) => zoneOf(senders.get(senderId)));
}

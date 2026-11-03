// approveStepDraft and approvedContent (README.md "Public interface", "Decided here"; docs/flows.md
// "An approval"; beta-p3-020): approvals' path, the one path that changes a sequence step's draft,
// in the caller's tenant run, which approvals' decision shares, so the freeze and the approval item
// commit together or not at all. The final text, the owner's or the draft's own, passes checkText
// every time; the draft becomes `approved`, under a condition on the status read, and nothing changes
// it again. The content hash lets the send compare what it carries with what the owner approved; the
// edit ratio says how much the owner changed the writer's text. Nothing here logs a text.
import { createHash } from "node:crypto";
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { requirePassingText } from "../gates/check-text.ts";
import { APPROVAL_TEXT_MAX, EDIT_RATIO_DECIMALS } from "./constants.ts";
import { parse } from "./store.ts";

/** What an approval answers: the frozen text's hash and how much the owner changed it, 0 to 1. */
export type StepDraftApproval = { readonly contentHash: string; readonly editRatio: number };
/** An approved step draft's frozen text, and its hash. */
export type ApprovedContent = { readonly text: string; readonly contentHash: string };

const approveStepDraftInput = z.object({
  /** The owner's final text, `""` for a note left empty; absent, the draft's own. */
  text: z.string().max(APPROVAL_TEXT_MAX).optional(),
  /** campaigns' `sx_` id of the step the approval is for: the draft must be its. */
  stepExecutionId: z.string().min(1).max(64),
});
export type ApproveStepDraftInput = z.input<typeof approveStepDraftInput>;

const draftColumns = {
  id: true,
  personId: true,
  channel: true,
  kind: true,
  status: true,
  stepExecutionId: true,
  text: true,
  editedText: true,
} as const;

/**
 * Approves the step's draft with the final text, trimmed: `text` when given, else the draft's own.
 * draft_not_found (404); draft_step_mismatch (409) for a lead's draft or another step's;
 * draft_not_ready (409) while it is `drafting`; draft_not_editable (409) once approved, also for the
 * loser of two approvals at once; draft_text_refused (400, `details.issues`) for a final text
 * checkText refuses, so a `failed` message is approved only with a typed text.
 */
export async function approveStepDraft(
  draftId: string,
  input: ApproveStepDraftInput,
): Promise<StepDraftApproval> {
  const { text, stepExecutionId } = parse(approveStepDraftInput, input);
  // Prisma drops an undefined value from a where: unchecked, that would be any draft.
  const draft = draftId
    ? await tenantClient.messageDraft.findFirst({ where: { id: draftId }, select: draftColumns })
    : null;
  if (draft === null) throw new AppError(errors.draft_not_found);
  if (draft.kind !== "outbound_step" || draft.stepExecutionId !== stepExecutionId) {
    throw new AppError(errors.draft_step_mismatch);
  }
  if (draft.status === "drafting") throw new AppError(errors.draft_not_ready);
  if (draft.status === "approved") throw new AppError(errors.draft_not_editable);

  const final = (text ?? draft.editedText ?? draft.text ?? "").trim();
  const { personId, channel, kind } = draft;
  await requirePassingText(final, { personId, channel, kind });
  const written = (draft.text ?? "").trim();
  const editRatio = editRatioOf(written, final);
  const now = new Date();
  // The frozen text is edited_text when the final text is not the stored one, exactly.
  const edit =
    final === draft.text
      ? { editedText: null, editedAt: null }
      : { editedText: final, editedAt: now };
  const data = {
    ...edit,
    status: "approved" as const,
    approvedAt: now,
    editedByUser: final !== written,
    editRatio,
  };
  const where = { id: draft.id, status: draft.status };
  const { count } = await tenantClient.messageDraft.updateMany({ where, data });
  // Another approval changed it since it was read: it won, and the frozen text is its.
  if (count === 0) throw new AppError(errors.draft_not_editable);
  return { contentHash: contentHashOf(final), editRatio };
}

/** The frozen text of the step's `approved` draft and its hash, read now; null for any other. */
export async function approvedContent(draftId: string): Promise<ApprovedContent | null> {
  if (!draftId) return null;
  const where = { id: draftId, kind: "outbound_step", status: "approved" } as const;
  const select = { text: true, editedText: true } as const;
  const draft = await tenantClient.messageDraft.findFirst({ where, select });
  const text = draft?.editedText ?? draft?.text ?? null;
  return text === null ? null : { text, contentHash: contentHashOf(text) };
}

/** The hex SHA-256 of the exact text, in UTF-8: what an approval freezes and the send compares. */
export function contentHashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * How much the final text differs from the writer's, both trimmed: the Levenshtein distance over
 * the longer length, in UTF-16 units as a length is counted, with edit_ratio's decimals; 0 when both
 * are empty.
 */
export function editRatioOf(written: string, final: string): number {
  const longer = Math.max(written.length, final.length);
  if (longer === 0) return 0;
  const scale = 10 ** EDIT_RATIO_DECIMALS;
  return Math.round((distance(written, final) / longer) * scale) / scale;
}

/** The Levenshtein distance: the fewest insertions, deletions and substitutions, by code unit. */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  let previous = Array.from({ length: short.length + 1 }, (_, index) => index);
  for (let i = 1; i <= long.length; i++) {
    const current = [i];
    for (let j = 1; j <= short.length; j++) {
      const same = long.charCodeAt(i - 1) === short.charCodeAt(j - 1);
      const replace = (previous[j - 1] ?? 0) + (same ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, replace);
    }
    previous = current;
  }
  return previous[short.length] ?? 0;
}

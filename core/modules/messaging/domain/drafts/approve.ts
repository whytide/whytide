// approveStepDraft and approvedContent (README.md "Public interface", "Decided here"; docs/flows.md
// "An approval"; beta-p3-020): approvals' path, the one path that changes a sequence step's draft,
// in the caller's tenant run, which approvals' decision shares, so the freeze and the approval item
// commit together or not at all. The final text, the owner's or the draft's own, passes checkText
// every time; the draft becomes `approved`, under a condition on the status read, and nothing changes
// it again. The content hash lets the send compare what it carries with what the owner approved; the
// edit ratio says how much the owner changed the writer's text. Nothing here logs a text. A first
// email (gamma-p3-070) freezes its subject with its body, and its hash covers both. The campaign's
// mode approves a `ready` draft without a person (approveStepDraftByMode, gamma-p4-080): its text
// ends with its channel's AI disclosure line before it freezes, so the hash covers the line; a
// person's approval never adds it. The one change of an approved draft: the mode's approval taken
// back when its campaign goes back to "Review everything" (reopenModeApproval, gamma-p4-070), the
// draft `ready` again with its writer's text, for a person to approve.
import { createHash } from "node:crypto";
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { type Channel, GATES, type GateName } from "../../schemas/writer.ts";
import { DISCLOSURE_LOCALE } from "../disclosure/constants.ts";
import { isDisclosureChannel, withDisclosure } from "../disclosure/line.ts";
import { hashOf } from "../dossier/hash.ts";
import { checkText, requirePassingText } from "../gates/check-text.ts";
import { APPROVAL_TEXT_MAX, EDIT_RATIO_DECIMALS } from "./constants.ts";
import { writtenKindOf } from "./kinds.ts";
import { parse } from "./store.ts";

/** What an approval answers: the frozen text's hash and how much the owner changed it, 0 to 1. */
export type StepDraftApproval = { readonly contentHash: string; readonly editRatio: number };
/**
 * An approved step draft's frozen text, and its hash; an email's also its subject, null for a
 * follow-up. A LinkedIn text has no `subject`. `disclosureApplied`: approved by the campaign's mode,
 * the text ending with its AI disclosure line; false for a person's approval.
 */
export type ApprovedContent = {
  readonly text: string;
  readonly subject?: string | null;
  readonly contentHash: string;
  readonly disclosureApplied: boolean;
};
/** What the mode's approval answers: the hash of the frozen content, its line included. */
export type StepDraftModeApproval = { readonly contentHash: string };

const approveStepDraftInput = z.object({
  /** The owner's final text, `""` for a note left empty; absent, the draft's own. */
  text: z.string().max(APPROVAL_TEXT_MAX).optional(),
  /** A first email's final subject; absent, the draft's own. Refused for any other draft. */
  subject: z.string().max(APPROVAL_TEXT_MAX).optional(),
  /** campaigns' `sx_` id of the step the approval is for: the draft must be its. */
  stepExecutionId: z.string().min(1).max(64),
});
export type ApproveStepDraftInput = z.input<typeof approveStepDraftInput>;

const approveByModeInput = z.strictObject({
  /** campaigns' `sx_` id of the step the approval is for: the draft must be its. */
  stepExecutionId: z.string().min(1).max(64),
});
/** The step alone: the mode approves the draft's own text, and takes no text or subject. */
export type ApproveStepDraftByModeInput = z.input<typeof approveByModeInput>;

const draftColumns = {
  id: true,
  personId: true,
  channel: true,
  kind: true,
  status: true,
  stepExecutionId: true,
  stepKey: true,
  stepKind: true,
  mailboxId: true,
  text: true,
  editedText: true,
  subject: true,
  editedSubject: true,
  disclosureApplied: true,
} as const;

/**
 * Approves the step's draft with the final text, trimmed: `text` when given, else the draft's own;
 * a first email's subject so too. draft_not_found (404); draft_step_mismatch (409) for a lead's
 * draft or another step's; draft_not_ready (409) while it is `drafting`; draft_not_editable (409)
 * once approved, also for the loser of two approvals at once; draft_subject_not_allowed (400) for a
 * subject on any draft but a first email; draft_text_refused (400, `details.issues`) for a final
 * text or subject checkText refuses, so a `failed` message is approved only with a typed text, and a
 * failed first email with a typed subject too.
 */
export async function approveStepDraft(
  draftId: string,
  input: ApproveStepDraftInput,
): Promise<StepDraftApproval> {
  const { text, subject, stepExecutionId } = parse(approveStepDraftInput, input);
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
  const stepKind = writtenKindOf(draft) ?? undefined;
  const first = draft.channel === "email" && stepKind === "email_first";
  if (subject !== undefined && !first) throw new AppError(errors.draft_subject_not_allowed);

  const final = (text ?? draft.editedText ?? draft.text ?? "").trim();
  const finalSubject = first
    ? (subject ?? draft.editedSubject ?? draft.subject ?? "").trim()
    : null;
  const { personId, channel, kind } = draft;
  const email = channel === "email" ? { subject: finalSubject, draftId: draft.id } : {};
  const mailbox = draft.mailboxId === null ? {} : { mailboxId: draft.mailboxId };
  const target = { personId, channel, kind, ...(stepKind && { stepKind }), ...email, ...mailbox };
  await requirePassingText(final, target);
  const written = (draft.text ?? "").trim();
  const editRatio = editRatioOf(written, final);
  const now = new Date();
  // The frozen text is edited_text when the final text is not the stored one, exactly; a first
  // email's frozen subject so too.
  const edit =
    final === draft.text
      ? { editedText: null, editedAt: null }
      : { editedText: final, editedAt: now };
  const subjectEdit = first
    ? { editedSubject: finalSubject === draft.subject ? null : finalSubject }
    : {};
  const changedSubject = first && finalSubject !== (draft.subject ?? "").trim();
  const data = {
    ...edit,
    ...subjectEdit,
    status: "approved" as const,
    approvedAt: now,
    editedByUser: final !== written || changedSubject,
    editRatio,
  };
  const where = { id: draft.id, status: draft.status };
  const { count } = await tenantClient.messageDraft.updateMany({ where, data });
  // Another approval changed it since it was read: it won, and the frozen text is its.
  if (count === 0) throw new AppError(errors.draft_not_editable);
  return { contentHash: contentHashOf(final, channel, finalSubject), editRatio };
}

/**
 * Approves the step's `ready` draft by the campaign's mode, never a person (gamma-p4-080): its own
 * text, trimmed, then a blank line and its channel's AI disclosure line, a first email's subject with
 * it, so that the hash the send compares covers the line. draft_not_found (404);
 * draft_step_mismatch (409) for a lead's draft or another step's; draft_not_ready (409) for any
 * draft but a `ready` LinkedIn message or email with a text, also for the loser of two approvals at
 * once; disclosure_check_failed (409, the failing gates' names in `details.gates`) for a text
 * checkText refuses, alone or once the line is added. A refusal changes nothing: the draft waits for
 * a person.
 */
export async function approveStepDraftByMode(
  draftId: string,
  input: ApproveStepDraftByModeInput,
): Promise<StepDraftModeApproval> {
  const { stepExecutionId } = parse(approveByModeInput, input);
  // Prisma drops an undefined value from a where: unchecked, that would be any draft.
  const draft = draftId
    ? await tenantClient.messageDraft.findFirst({ where: { id: draftId }, select: draftColumns })
    : null;
  if (draft === null) throw new AppError(errors.draft_not_found);
  if (draft.kind !== "outbound_step" || draft.stepExecutionId !== stepExecutionId) {
    throw new AppError(errors.draft_step_mismatch);
  }
  const { personId, channel, kind } = draft;
  const body = (draft.editedText ?? draft.text ?? "").trim();
  // Only a text the writer's gates passed, never the line alone, and never a note.
  if (draft.status !== "ready" || !isDisclosureChannel(channel) || body === "") {
    throw new AppError(errors.draft_not_ready);
  }
  const stepKind = writtenKindOf(draft) ?? undefined;
  const first = channel === "email" && stepKind === "email_first";
  const subject = first ? (draft.editedSubject ?? draft.subject ?? "").trim() : null;
  const final = withDisclosure(body, channel, DISCLOSURE_LOCALE);
  const email = channel === "email" ? { subject, draftId: draft.id } : {};
  const mailbox = draft.mailboxId === null ? {} : { mailboxId: draft.mailboxId };
  const target = { personId, channel, kind, ...(stepKind && { stepKind }), ...email, ...mailbox };
  // The body as a person's approval checks it, then with its line: the line lowers an email's
  // near-duplicate measure, so the mode's approval is never easier than a person's.
  const failed = new Set<GateName>();
  for (const text of [body, final]) {
    const check = await checkText(text, target);
    if (!check.ok) for (const { gate } of check.issues) failed.add(gate);
  }
  if (failed.size > 0) {
    // The gates' names only: no person reads this refusal, and an issue may quote the text.
    const gates = GATES.filter((gate) => failed.has(gate));
    throw new AppError(errors.disclosure_check_failed, { details: { gates } });
  }
  const now = new Date();
  const data = {
    editedText: final,
    editedAt: now,
    ...(first && { editedSubject: subject === draft.subject ? null : subject }),
    status: "approved" as const,
    approvedAt: now,
    // The line is the platform's words, not a person's edit.
    editedByUser: false,
    editRatio: 0,
    disclosureApplied: true,
  };
  const where = { id: draft.id, status: "ready" as const };
  const { count } = await tenantClient.messageDraft.updateMany({ where, data });
  // Changed since it was read, by a person's approval most likely: it is no longer `ready`.
  if (count === 0) throw new AppError(errors.draft_not_ready);
  return { contentHash: contentHashOf(final, channel, subject) };
}

/**
 * The mode's approval of the step's draft taken back (the file's header): `ready` again, its
 * writer's text and subject as they were before the mode's approval froze them, the AI disclosure
 * line, the time and the edit's measure gone. A person's approval is never taken back:
 * draft_not_found (404) for any draft but the step's own that the mode approved. A `ready` draft has
 * no edited text (an edit makes it `edited`), so the writer's is the text the mode approved.
 */
export async function reopenModeApproval(
  draftId: string,
  input: ApproveStepDraftByModeInput,
): Promise<void> {
  const { stepExecutionId } = parse(approveByModeInput, input);
  // Prisma drops an undefined value from a where: unchecked, that would be any draft.
  if (!draftId) throw new AppError(errors.draft_not_found);
  const where = {
    id: draftId,
    kind: "outbound_step",
    stepExecutionId,
    status: "approved",
    disclosureApplied: true,
  } as const;
  const data = {
    status: "ready" as const,
    editedText: null,
    editedAt: null,
    editedSubject: null,
    approvedAt: null,
    editedByUser: false,
    editRatio: null,
    disclosureApplied: false,
  };
  const { count } = await tenantClient.messageDraft.updateMany({ where, data });
  if (count === 0) throw new AppError(errors.draft_not_found);
}

/**
 * The frozen text of the step's `approved` draft and its hash, read now, an email's with its frozen
 * subject, null for a follow-up, and whether the campaign's mode approved it with its disclosure
 * line; null for any other draft.
 */
export async function approvedContent(draftId: string): Promise<ApprovedContent | null> {
  if (!draftId) return null;
  const where = { id: draftId, kind: "outbound_step", status: "approved" } as const;
  const draft = await tenantClient.messageDraft.findFirst({ where, select: draftColumns });
  const text = draft?.editedText ?? draft?.text ?? null;
  if (draft === null || text === null) return null;
  const { disclosureApplied } = draft;
  if (draft.channel !== "email")
    return { text, contentHash: contentHashOf(text, draft.channel, null), disclosureApplied };
  const first = writtenKindOf(draft) === "email_first";
  const subject = first ? (draft.editedSubject ?? draft.subject) : null;
  return {
    text,
    subject,
    contentHash: contentHashOf(text, draft.channel, subject),
    disclosureApplied,
  };
}

/**
 * What an approval freezes and the send compares: the hex SHA-256 of a LinkedIn text, exactly, in
 * UTF-8; of an email, the canonical JSON of `{ body, subject }`, keys sorted, `subject` null for a
 * follow-up, so that the hash changes when either changes.
 */
export function contentHashOf(text: string, channel: Channel, subject: string | null): string {
  if (channel === "email") return hashOf({ body: text, subject });
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

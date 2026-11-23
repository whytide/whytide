// checkText (README.md "Routes", "Decided here"; docs/flows.md "An edit", "An approval"): the gates a
// text that may be sent passes, whoever wrote it: a member's edit (editDraft), an approval
// (approveStepDraft), approvals' "Up next". In the caller's tenant run, on the text trimmed: its
// length within editLimitsOf, no placeholder, no red line, no colleague's signal and no signal's act,
// the person's colleagues read through contacts' colleaguesOf in the same run, so that one imported a
// moment earlier counts; an email's subject too, a first email's links, and a step's email body
// against its mailbox's other drafts of the window, read here, without the draft itself
// (gamma-p3-070). The writer's gates (index.ts) are the same functions with grounding, which needs
// the dossier, built in a run of its own; a member reads every text they edit or approve.
import { colleaguesOf } from "@whytide/contacts";
import { type TenantClient, tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { DRAFT_KINDS } from "../../schemas/drafts.ts";
import { CHANNELS, type Channel, type GateIssue } from "../../schemas/writer.ts";
import { MS_PER_HOUR, WRITTEN_STEP_KINDS, type WrittenStepKind } from "../drafts/constants.ts";
import { kindFits } from "../drafts/kinds.ts";
import { NEAR_DUPLICATE_WINDOW_HOURS } from "./constants.ts";
import { type DraftKind, editLimitsOf, issuesOf, textGates } from "./index.ts";

/** What the text is for: the draft's person, channel and kind; an email's kind, subject and mailbox. */
export type TextCheckInput = {
  readonly personId: string;
  readonly channel: Channel;
  readonly kind: DraftKind;
  /** The kind it is written as, which fits the channel; an email without one is a first email. */
  readonly stepKind?: WrittenStepKind;
  /** An email's final subject; none for a follow-up. */
  readonly subject?: string | null;
  /** A step's email: its mailbox, whose other drafts of the last day its body is compared with. */
  readonly mailboxId?: string;
  /** The draft the text is for, which that comparison leaves out. */
  readonly draftId?: string;
};
/** A pass, or the issues in the gates' order, as `gateIssue` writes them. */
export type TextCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly GateIssue[] };

const id = z.string().min(1).max(64);
const checkTextInput = z.object({
  text: z.string(),
  personId: id,
  channel: z.enum(CHANNELS),
  kind: z.enum(DRAFT_KINDS),
  stepKind: z.enum(WRITTEN_STEP_KINDS).optional(),
  subject: z.string().nullable().optional(),
  mailboxId: id.optional(),
  draftId: id.optional(),
});

/**
 * The text's gates but grounding, on the text trimmed. messaging_input_invalid, naming the fields,
 * for an input off its shape, a kind that does not fit the channel, or a subject or a mailbox off
 * an email; contacts' person_not_found for a person the workspace does not hold.
 */
export async function checkText(text: string, target: TextCheckInput): Promise<TextCheck> {
  const parsed = checkTextInput.safeParse({ ...target, text });
  const fields = parsed.success
    ? offEmail(parsed.data)
    : [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
  if (!parsed.success || fields.length > 0) {
    throw new AppError(errors.messaging_input_invalid, { details: { fields } });
  }
  const { personId, channel, kind, stepKind, subject = null, mailboxId, draftId } = parsed.data;
  const said = parsed.data.text.trim();
  const colleagues = await colleaguesOf(personId);
  const others =
    channel === "email" && mailboxId !== undefined
      ? await mailboxBodies(tenantClient, mailboxId, draftId)
      : undefined;
  const first = (stepKind ?? "email_first") === "email_first";
  const email = { subject: subject?.trim() ?? null, first, ...(others && { others }) };
  const limits = editLimitsOf(channel, kind);
  const gates = textGates(said, { limits, colleagues, ...(channel === "email" && { email }) });
  const issues = issuesOf(gates);
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** checkText's pass, or draft_text_refused with its issues in `details.issues`. */
export async function requirePassingText(text: string, target: TextCheckInput): Promise<void> {
  const check = await checkText(text, target);
  if (!check.ok) {
    throw new AppError(errors.draft_text_refused, { details: { issues: check.issues } });
  }
}

/**
 * The final bodies of the mailbox's other drafts made or approved in the last
 * NEAR_DUPLICATE_WINDOW_HOURS, in the run's workspace, empty ones left out: read in code only, for
 * the near-duplicate gate, never sent on. A body the campaign's mode approved is the writer's text,
 * without the AI disclosure line every such body ends with, which would lower the measure
 * (gamma-p4-080).
 */
export async function mailboxBodies(
  client: Pick<TenantClient, "messageDraft">,
  mailboxId: string,
  draftId?: string,
): Promise<string[]> {
  const since = new Date(Date.now() - NEAR_DUPLICATE_WINDOW_HOURS * MS_PER_HOUR);
  const where = {
    mailboxId,
    ...(draftId !== undefined && { id: { not: draftId } }),
    OR: [{ createdAt: { gte: since } }, { approvedAt: { gte: since } }],
  };
  const select = { text: true, editedText: true, disclosureApplied: true } as const;
  const rows = await client.messageDraft.findMany({ where, select });
  return rows.flatMap(({ text, editedText, disclosureApplied }) => {
    const body = ((disclosureApplied ? text : (editedText ?? text)) ?? "").trim();
    return body === "" ? [] : [body];
  });
}

/** The fields a target sets off its channel: a kind that does not fit, a subject or a mailbox. */
function offEmail(target: z.output<typeof checkTextInput>): string[] {
  const { channel, stepKind, subject, mailboxId } = target;
  const email = channel === "email";
  return [
    ...(stepKind !== undefined && !kindFits(stepKind, channel) ? ["stepKind"] : []),
    ...(!email && (subject ?? null) !== null ? ["subject"] : []),
    ...(!email && mailboxId !== undefined ? ["mailboxId"] : []),
  ];
}

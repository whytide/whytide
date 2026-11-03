// checkText (README.md "Routes", "Decided here"; docs/flows.md "An edit", "An approval"): the gates a
// text that may be sent passes, whoever wrote it: a member's edit (editDraft), an approval
// (approveStepDraft), approvals' "Up next". In the caller's tenant run, on the text trimmed: its
// length within editLimitsOf, no placeholder, no red line and no colleague's signal, the person's
// colleagues read through contacts' colleaguesOf in the same run, so that one imported a moment
// earlier counts. The writer's gates (index.ts) are the same functions with grounding, which needs
// the dossier, built in a run of its own; a member reads every text they edit or approve.
import { colleaguesOf } from "@whytide/contacts";
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { DRAFT_KINDS } from "../../schemas/drafts.ts";
import { CHANNELS, type Channel, type GateIssue } from "../../schemas/writer.ts";
import { colleagueIssues } from "./colleague.ts";
import { lengthIssues, placeholderIssues, redLineIssues } from "./format.ts";
import { type DraftKind, editLimitsOf } from "./index.ts";

/** What the text is for: the draft's person, channel and kind. */
export type TextCheckInput = {
  readonly personId: string;
  readonly channel: Channel;
  readonly kind: DraftKind;
};
/** A pass, or the issues in the gates' order, as `gateIssue` writes them. */
export type TextCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly GateIssue[] };

const checkTextInput = z.object({
  text: z.string(),
  personId: z.string().min(1).max(64),
  channel: z.enum(CHANNELS),
  kind: z.enum(DRAFT_KINDS),
});

/**
 * The text's gates but grounding, on the text trimmed. messaging_input_invalid, naming the fields,
 * for an input off its shape; contacts' person_not_found for a person the workspace does not hold.
 */
export async function checkText(text: string, target: TextCheckInput): Promise<TextCheck> {
  const parsed = checkTextInput.safeParse({ ...target, text });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new AppError(errors.messaging_input_invalid, { details: { fields } });
  }
  const { personId, channel, kind } = parsed.data;
  const said = parsed.data.text.trim();
  const colleagues = await colleaguesOf(personId);
  const issues = [
    ...placeholderIssues(said),
    ...lengthIssues(said, editLimitsOf(channel, kind)),
    ...redLineIssues(said),
    ...colleagueIssues(said, colleagues),
  ];
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** checkText's pass, or draft_text_refused with its issues in `details.issues`. */
export async function requirePassingText(text: string, target: TextCheckInput): Promise<void> {
  const check = await checkText(text, target);
  if (!check.ok) {
    throw new AppError(errors.draft_text_refused, { details: { issues: check.issues } });
  }
}

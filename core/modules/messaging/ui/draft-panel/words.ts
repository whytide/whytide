// The draft panel's words for what a draft holds (messages/en.json, `messaging.draft.*`), each key
// written out in a literal map so that the message check reads every one: the channels, the plan's
// angles and calls to action, the gates, a draft's mark, a failed draft's codes; and a fact's
// source, worded from its reference's table and column, never the reference, which holds record ids.
import { useTranslations } from "next-intl";
import type { DraftResponse as Draft } from "../../schemas/drafts.ts";

type Plan = NonNullable<Draft["plan"]>;

/** The value of `key` in `words`: never a member every object inherits, such as `constructor`. */
const pick = <T>(words: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(words, key) ? words[key] : undefined;

export function useDraftWords() {
  const t = useTranslations("messaging.draft");
  const channel: Record<Draft["channel"], string> = {
    linkedin_note: t("channel.note"),
    linkedin_message: t("channel.message"),
  };
  const angle: Record<Plan["angle"], string> = {
    signal_comment: t("angle.signal_comment"),
    signal_reaction: t("angle.signal_reaction"),
    pain_point: t("angle.pain_point"),
    proof_point: t("angle.proof_point"),
  };
  const cta: Record<Plan["cta"], string> = {
    question: t("cta.question"),
    soft_ask: t("cta.soft_ask"),
    resource: t("cta.resource"),
  };
  const gate: Record<Draft["gates"][number]["gate"], string> = {
    facts_used: t("gate.facts_used"),
    placeholders: t("gate.placeholders"),
    length: t("gate.length"),
    grounding: t("gate.grounding"),
    red_lines: t("gate.red_lines"),
    colleague_signal: t("gate.colleague_signal"),
  };
  /**
   * A draft's mark, in the history and over the newest: none for a ready one. The panel lists a
   * lead's drafts only, and only a sequence step's is ever approved.
   */
  const mark: Record<Draft["status"], string | undefined> = {
    drafting: t("drafting"),
    ready: undefined,
    flagged: t("flagged"),
    failed: t("failed"),
    edited: t("edited"),
    approved: undefined,
  };
  /** Why a failed draft failed, by its code (README.md "The writer"): none off the six. */
  const failure = (code: string) =>
    pick(
      {
        ai_failed: t("failure.ai_failed"),
        draft_requester_not_member: t("failure.draft_requester_not_member"),
        dossier_lead_not_found: t("failure.dossier_lead_not_found"),
        write_failed: t("failure.write_failed"),
        earlier_draft_invalid: t("failure.earlier_draft_invalid"),
        draft_stuck: t("failure.draft_stuck"),
      },
      code,
    );
  const sources: Record<string, (column: string) => string> = {
    users: (column) => t("source.users", { column }),
    company_knowledge: (column) => t("source.company_knowledge", { column }),
    persons: (column) => t("source.persons", { column }),
    workspace_companies: (column) => t("source.workspace_companies", { column }),
    evidence: (column) => t("source.evidence", { column }),
    signal_events: (column) => t("source.signal_events", { column }),
  };
  /** A fact's source, from `<table>/<id>/<column>`, then an item's index. */
  const source = (sourceRef: string) => {
    const [table = "", , column = ""] = sourceRef.split("/");
    return pick(sources, table)?.(column) ?? t("source.other");
  };
  return { channel, angle, cta, gate, mark, failure, source };
}

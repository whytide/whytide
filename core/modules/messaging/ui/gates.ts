// The words of messaging's gate keys (messages/en.json) for the draft panel (alpha-p9-030), which
// lists a flagged draft's reasons: one t() call per key, written out, so that the message check
// reads every key. An issue's fields are its message's params (schemas/writer.ts, docs/data.md).
import {
  EMAIL_SUBJECT_MAX_CHARACTERS,
  EMAIL_SUBJECT_MAX_WORDS,
} from "../domain/gates/constants.ts";
import type { GateIssue } from "../schemas/writer.ts";

type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string;
/** A first email's subject's limits, which a too long subject's words name. */
const SUBJECT_LIMITS = {
  maxWords: EMAIL_SUBJECT_MAX_WORDS,
  maxCharacters: EMAIL_SUBJECT_MAX_CHARACTERS,
};

/** A gate issue's words. */
export function gateIssueText(t: Translate, issue: GateIssue): string {
  switch (issue.gate) {
    case "facts_used":
      return t("messaging.gate.facts_used", issue);
    case "placeholders":
      return t("messaging.gate.placeholders", issue);
    case "length":
      // A LinkedIn text's issue names no unit: its characters.
      return t("messaging.gate.length", { ...issue, unit: issue.unit ?? "characters" });
    case "grounding":
      return t("messaging.gate.grounding", issue);
    case "red_lines":
      return t("messaging.gate.red_lines", issue);
    case "colleague_signal":
      return t("messaging.gate.colleague_signal", issue);
    case "signal_act":
      return t("messaging.gate.signal_act", issue);
    case "subject":
      return t("messaging.gate.subject", { ...issue, ...SUBJECT_LIMITS });
    case "links":
      return t("messaging.gate.links", issue);
    case "near_duplicate":
      return t("messaging.gate.near_duplicate", issue);
  }
}

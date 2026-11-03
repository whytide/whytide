// The words of messaging's gate keys (messages/en.json) for the draft panel (alpha-p9-030), which
// lists a flagged draft's reasons: one t() call per key, written out, so that the message check
// reads every key. An issue's fields are its message's params (schemas/writer.ts, docs/data.md).
import type { GateIssue } from "../schemas/writer.ts";

type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

/** A gate issue's words. */
export function gateIssueText(t: Translate, issue: GateIssue): string {
  switch (issue.gate) {
    case "facts_used":
      return t("messaging.gate.facts_used", issue);
    case "placeholders":
      return t("messaging.gate.placeholders", issue);
    case "length":
      return t("messaging.gate.length", issue);
    case "grounding":
      return t("messaging.gate.grounding", issue);
    case "red_lines":
      return t("messaging.gate.red_lines", issue);
  }
}

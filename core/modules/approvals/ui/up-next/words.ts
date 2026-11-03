// "Up next"'s words for what a row holds (messages/en.json, `approvals.up_next.*`), each key written
// out so that the message check reads every one: the lead's name and role, a step's name, why an
// approved step waits, a gate's issue with what it found, and a fact's source, worded from its
// reference's table and column, never the reference, which holds record ids. The steps', gates' and
// codes' names are open strings (README.md "Screen"): one off these lists gets a generic word.
import { useTranslations } from "next-intl";
import type { ItemResponse } from "../../schemas/items.ts";

type Lead = NonNullable<ItemResponse["lead"]>;
/** A gate's issue as messaging writes it: the gate, and what it found. */
export type GateIssue = { readonly gate: string; readonly [field: string]: unknown };

/** The value of `key` in `words`: never a member every object inherits, such as `constructor`. */
const pick = <T>(words: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(words, key) ? words[key] : undefined;
const text = (issue: GateIssue, field: string) => {
  const value = issue[field];
  return typeof value === "string" ? value : "";
};
const count = (issue: GateIssue, field: string) => {
  const value = issue[field];
  return typeof value === "number" ? value : 0;
};

export function useUpNextWords() {
  const t = useTranslations("approvals.up_next");
  const steps: Record<string, string> = {
    connect: t("step.connect"),
    message_1: t("step.message_1"),
    follow_up_1: t("step.follow_up_1"),
    follow_up_2: t("step.follow_up_2"),
  };
  const waits: Record<string, string> = {
    insufficient_credits: t("wait.insufficient_credits"),
    invite_note_budget: t("wait.invite_note_budget"),
  };
  const gates: Record<string, (issue: GateIssue) => string> = {
    length: (issue) =>
      t("gate.length", {
        length: count(issue, "length"),
        min: count(issue, "min"),
        max: count(issue, "max"),
      }),
    placeholders: (issue) => t("gate.placeholders", { placeholder: text(issue, "placeholder") }),
    red_lines: (issue) => t("gate.red_lines", { phrase: text(issue, "phrase") }),
    colleague_signal: (issue) => t("gate.colleague_signal", { phrase: text(issue, "phrase") }),
    grounding: (issue) => t("gate.grounding", { entity: text(issue, "entity") }),
    facts_used: () => t("gate.facts_used"),
  };
  const sources: Record<string, (column: string) => string> = {
    users: (column) => t("source.users", { column }),
    company_knowledge: (column) => t("source.company_knowledge", { column }),
    persons: (column) => t("source.persons", { column }),
    workspace_companies: (column) => t("source.workspace_companies", { column }),
    evidence: (column) => t("source.evidence", { column }),
    signal_events: (column) => t("source.signal_events", { column }),
  };

  return {
    /** The lead's name, "A lead without a name", or that contacts no longer has the lead. */
    name: (lead: Lead | null) =>
      lead === null
        ? t("lead.gone")
        : t("lead.name", { first: lead.firstName ?? "", last: lead.lastName ?? "" }).trim() ||
          t("lead.unnamed"),
    /** The title at the company, or whichever of the two the lead has. */
    role: ({ title, companyName }: Lead) =>
      title && companyName
        ? t("lead.role", { title, company: companyName })
        : title || companyName || undefined,
    /** The step's name: the sequence's step, else its action's. */
    step: (stepKey: string, actionType: ItemResponse["actionType"]) =>
      pick(steps, stepKey) ?? (actionType === "invite" ? t("step.connect") : t("step.message")),
    wait: (code: string) => pick(waits, code) ?? t("wait.other"),
    gate: (issue: GateIssue) => pick(gates, issue.gate)?.(issue) ?? t("gate.other"),
    /** A fact's source, from `<table>/<id>/<column>`, then an item's index. */
    source: (sourceRef: string) => {
      const [table = "", , column = ""] = sourceRef.split("/");
      return pick(sources, table)?.(column) ?? t("source.other");
    },
  };
}

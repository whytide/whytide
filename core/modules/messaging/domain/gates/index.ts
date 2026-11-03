// The gates (docs/security.md "The gates"; security §6, briefs RB-10.2.1): code writeDraft runs
// after each successful call of an agent, on its validated answer: the plan's facts_used, then the
// text's placeholders, length, grounding, red_lines and colleague_signal (beta-p3-020). Each answers
// its result, with no issue for a pass, and never throws; an answer with an issue is regenerated
// with the issues in its <failures> block (domain/drafts/write.ts). An edit and an approval run the
// same checks but grounding (check-text.ts).
import type { Dossier } from "../../schemas/dossier.ts";
import type { DRAFT_KINDS } from "../../schemas/drafts.ts";
import type { Channel, GateIssue, GateName, PlanInput, PlanOutput } from "../../schemas/writer.ts";
import { settings } from "../../settings.ts";
import { type Colleague, colleagueIssues } from "./colleague.ts";
import { MESSAGE_HARD_LIMIT, STEP_NOTE_MIN_CHARACTERS, TEXT_MIN_CHARACTERS } from "./constants.ts";
import { type Limits, lengthIssues, placeholderIssues, redLineIssues } from "./format.ts";
import { groundingIssues } from "./grounding.ts";
import { MESSAGE_RANGE } from "./range.ts";

export type { Colleague } from "./colleague.ts";
export type { Limits } from "./format.ts";
/** One gate's verdict, as the draft's `gates` keeps it: no issue for a pass. */
export type GateResult = { readonly gate: GateName; readonly issues: readonly GateIssue[] };
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** The characters a channel's text must have: a note, LinkedIn's limit; a message, its range. */
export function limitsOf(channel: Channel): Limits {
  return channel === "linkedin_note"
    ? { min: TEXT_MIN_CHARACTERS, max: settings.LINKEDIN_NOTE_LIMIT }
    : MESSAGE_RANGE;
}

/** The most characters a channel's text may have, a member's edit included: LinkedIn's limits. */
export function hardLimitOf(channel: Channel): number {
  return channel === "linkedin_note" ? settings.LINKEDIN_NOTE_LIMIT : MESSAGE_HARD_LIMIT;
}

/**
 * The characters an edited or approved text may have: up to the channel's hard limit, from one,
 * but from none for a sequence step's note, which may be sent as no note.
 */
export function editLimitsOf(channel: Channel, kind: DraftKind): Limits {
  const emptyNote = channel === "linkedin_note" && kind === "outbound_step";
  const min = emptyNote ? STEP_NOTE_MIN_CHARACTERS : TEXT_MIN_CHARACTERS;
  return { min, max: hardLimitOf(channel) };
}

/** The fact ids of the blocks the planner reads: the only ones a plan may cite. */
export function factIdsOf(blocks: Pick<PlanInput, "dossier" | "lead" | "why_now">): Set<string> {
  const { company, ...lead } = blocks.lead;
  const cited = [
    ...Object.values(blocks.dossier).flatMap((part) => Object.values(part)),
    ...Object.values(lead),
    ...Object.values(company),
    ...blocks.why_now.flatMap((event) => Object.values(event)),
  ];
  return new Set(cited.flatMap((values) => Object.keys(values)));
}

/** The plan's gate: every fact id it cites is one the planner read. */
export function checkPlan(plan: PlanOutput, known: ReadonlySet<string>): GateResult[] {
  const unknown = [...new Set(plan.factIds)].filter((factId) => !known.has(factId));
  return [
    { gate: "facts_used", issues: unknown.map((factId) => ({ gate: "facts_used", factId })) },
  ];
}

/** The written text's gates, in their order: the person's colleagues are contacts' colleaguesOf. */
export function checkWrittenText(
  text: string,
  dossier: Dossier,
  limits: Limits,
  colleagues: readonly Colleague[],
): GateResult[] {
  return [
    { gate: "placeholders", issues: placeholderIssues(text) },
    { gate: "length", issues: lengthIssues(text, limits) },
    { gate: "grounding", issues: groundingIssues(text, dossier) },
    { gate: "red_lines", issues: redLineIssues(text) },
    { gate: "colleague_signal", issues: colleagueIssues(text, colleagues) },
  ];
}

/** The issues of the results, in the gates' order. */
export const issuesOf = (results: readonly GateResult[]): GateIssue[] =>
  results.flatMap(({ issues }) => issues);

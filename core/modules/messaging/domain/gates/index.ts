// The gates (docs/security.md "The gates"; security §6, briefs RB-10.2.1): code writeDraft runs
// after each successful call of an agent, on its validated answer: the plan's facts_used, then the
// text's placeholders, length, grounding, red_lines and colleague_signal (beta-p3-020). Each answers
// its result, with no issue for a pass, and never throws; an answer with an issue is regenerated
// with the issues in its <failures> block (domain/drafts/write.ts). An edit and an approval run the
// same checks but grounding (check-text.ts). gamma-p3-070's policies (policies.ts) follow:
// signal_act on every channel, then an email's subject, a first email's links and a step's email
// against its mailbox's near duplicates; the text's gates read an email's subject as its body.
import type { Dossier } from "../../schemas/dossier.ts";
import type { DRAFT_KINDS } from "../../schemas/drafts.ts";
import {
  type Channel,
  GATES,
  type GateIssue,
  type GateName,
  type PlanInput,
  type PlanOutput,
} from "../../schemas/writer.ts";
import { settings } from "../../settings.ts";
import { type Colleague, colleagueIssues } from "./colleague.ts";
import {
  EMAIL_WORD_RANGE,
  MESSAGE_HARD_LIMIT,
  STEP_NOTE_MIN_CHARACTERS,
  TEXT_MIN_CHARACTERS,
} from "./constants.ts";
import { type Limits, lengthIssues, placeholderIssues, redLineIssues } from "./format.ts";
import { type GroundingOptions, groundingIssues } from "./grounding.ts";
import { linkIssues, nearDuplicateIssues, signalActIssues, subjectIssues } from "./policies.ts";
import { MESSAGE_RANGE } from "./range.ts";

export type { Colleague } from "./colleague.ts";
export type { Limits } from "./format.ts";
/** One gate's verdict, as the draft's `gates` keeps it: no issue for a pass. */
export type GateResult = { readonly gate: GateName; readonly issues: readonly GateIssue[] };
export type DraftKind = (typeof DRAFT_KINDS)[number];

/**
 * What the writer's text must have: a note, LinkedIn's limit; a message, its range of characters;
 * an email's body, its range of words.
 */
export function limitsOf(channel: Channel): Limits {
  if (channel === "email") return { ...EMAIL_WORD_RANGE, unit: "words" };
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
 * but from none for a sequence step's note, which may be sent as no note; an email's body names
 * its unit, as its writer's words do.
 */
export function editLimitsOf(channel: Channel, kind: DraftKind): Limits {
  const emptyNote = channel === "linkedin_note" && kind === "outbound_step";
  const min = emptyNote ? STEP_NOTE_MIN_CHARACTERS : TEXT_MIN_CHARACTERS;
  const limits = { min, max: hardLimitOf(channel) };
  return channel === "email" ? { ...limits, unit: "characters" } : limits;
}

/** What an email's gates read besides its body (gamma-p3-070). */
export type EmailCheck = {
  /** The subject, null for none. */
  readonly subject: string | null;
  /** A first email: a subject, and no link. */
  readonly first: boolean;
  /** The bodies of the mailbox's other drafts of the window; absent without a mailbox. */
  readonly others?: readonly string[];
};
/** What a text is checked against: grounding needs the dossier, which an edit has not. */
export type TextGates = {
  readonly limits: Limits;
  readonly colleagues: readonly Colleague[];
  readonly dossier?: Dossier;
  /** A reply's: the brief and the conversation, and another language's numbers only. */
  readonly grounding?: GroundingOptions;
  readonly email?: EmailCheck;
};

/** The gates a written draft keeps, in their order: an email's own by its kind and mailbox. */
export function gatesOf(channel: Channel, email: { first?: boolean; mailbox?: boolean } = {}) {
  const own: Partial<Record<GateName, boolean>> = {
    subject: channel === "email",
    links: channel === "email" && email.first === true,
    near_duplicate: channel === "email" && email.mailbox === true,
  };
  return GATES.filter((gate) => own[gate] ?? true);
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
  email?: EmailCheck,
): GateResult[] {
  return textGates(text, { limits, colleagues, dossier, ...(email && { email }) });
}

/**
 * The text's gates, grounding only with a dossier: on an email's subject and body each, its length
 * on the body alone, then an email's own.
 */
export function textGates(text: string, target: TextGates): GateResult[] {
  const { limits, colleagues, dossier, grounding, email } = target;
  const subject = email?.subject ?? "";
  const parts = subject === "" ? [text] : [subject, text];
  const each = (check: (part: string) => GateIssue[]) => unique(parts.flatMap(check));
  const results: GateResult[] = [
    { gate: "placeholders", issues: each(placeholderIssues) },
    { gate: "length", issues: lengthIssues(text, limits) },
    ...(dossier
      ? [
          {
            gate: "grounding" as const,
            issues: each((p) => groundingIssues(p, dossier, grounding)),
          },
        ]
      : []),
    { gate: "red_lines", issues: each(redLineIssues) },
    { gate: "colleague_signal", issues: each((part) => colleagueIssues(part, colleagues)) },
    { gate: "signal_act", issues: each(signalActIssues) },
  ];
  if (email === undefined) return results;
  const { first, others } = email;
  const own: GateResult[] = [
    { gate: "subject", issues: subjectIssues(email.subject, first) },
    ...(first ? [{ gate: "links" as const, issues: linkIssues(parts) }] : []),
    ...(others
      ? [{ gate: "near_duplicate" as const, issues: nearDuplicateIssues(text, others) }]
      : []),
  ];
  return [...results, ...own];
}

/** Each issue once, in order: a subject and its body may hold the same one. */
function unique(issues: readonly GateIssue[]): GateIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The issues of the results, in the gates' order. */
export const issuesOf = (results: readonly GateResult[]): GateIssue[] =>
  results.flatMap(({ issues }) => issues);

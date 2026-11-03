// "Why this lead" (docs/concepts.md "The why", F04 §8): up to three bullets built in code from the
// stored verdicts, the ICP's criteria, the disqualifiers or the hard filters' miss, never from the
// model's summary. A bullet is a message key with its params, codes and quotes only, never a word of
// English, so that the screen words it in the viewer's language (messages/en.json; the params of each
// key in docs/data.md). Pure.
import type { WhyBullet } from "@whytide/contacts";
import type { Criterion, Disqualifier, Verdict } from "../../schemas/assess-fit.ts";
import type { HardFilterDetail, HardFilterReason } from "../hard-filters/index.ts";
import { counting, firstDisqualifier, type ScoringCriterion } from "../score/index.ts";

/** A param's longest text, in code points, as contacts checks a bullet. */
const PARAM_MAX = 300;

/** The keys buildWhy writes, each with its message in messages/en.json. */
export type WhyKey =
  | "qualification.why.disqualified"
  | "qualification.why.fit"
  | "qualification.why.gap"
  | "qualification.why.hard_filtered"
  | "qualification.why.must_missed";
export type WhyInput = {
  readonly verdicts: readonly {
    readonly criterion: Criterion;
    readonly verdict: Verdict;
    readonly evidence: string;
  }[];
  readonly criteria: readonly ScoringCriterion[];
  readonly disqualifiers: readonly Disqualifier[];
  /** The hard filters' miss, for a lead they stopped, which has no verdicts. */
  readonly hardFilter?: { readonly reason: HardFilterReason; readonly detail: HardFilterDetail };
};
type Counted = WhyInput["verdicts"][number] & { readonly weight: number; readonly isMust: boolean };

/**
 * At most three bullets, in this order: what stops the lead (the hard filters' miss, else the first
 * disqualifier, else the strongest must at not_met); the fit (the strongest criterion met, its quote,
 * and how many of those that count are met); the data gap (the strongest unknown, and how many more).
 * Strongest is the heaviest weight, ties in the criteria's order; a disabled criterion is in none.
 */
export function buildWhy(input: WhyInput): WhyBullet[] {
  const counted = counting(input.verdicts, input.criteria).sort((a, b) => b.weight - a.weight);
  const bullets = [stopping(input, counted), fit(counted), gap(counted)];
  return bullets.filter((bullet) => bullet !== null);
}

function stopping(input: WhyInput, counted: readonly Counted[]): WhyBullet | null {
  if (input.hardFilter) {
    const { reason, detail } = input.hardFilter;
    const params = { reason, value: cut(detail.value), icp: cut(detail.icp.join(", ")) };
    return bullet("qualification.why.hard_filtered", params);
  }
  const disqualifier = firstDisqualifier(input.disqualifiers);
  if (disqualifier !== null) return bullet("qualification.why.disqualified", { disqualifier });
  const missed = counted.find((verdict) => verdict.isMust && verdict.verdict === "not_met");
  if (missed === undefined) return null;
  const params = { criterion: missed.criterion, quote: cut(missed.evidence) };
  return bullet("qualification.why.must_missed", params);
}

function fit(counted: readonly Counted[]): WhyBullet | null {
  const met = counted.filter((verdict) => verdict.verdict === "met");
  const [strongest] = met;
  if (strongest === undefined) return null;
  const { criterion, evidence } = strongest;
  const params = { criterion, quote: cut(evidence), met: met.length, total: counted.length };
  return bullet("qualification.why.fit", params);
}

function gap(counted: readonly Counted[]): WhyBullet | null {
  const unknown = counted.filter((verdict) => verdict.verdict === "unknown");
  const [strongest] = unknown;
  if (strongest === undefined) return null;
  const params = { criterion: strongest.criterion, more: unknown.length - 1 };
  return bullet("qualification.why.gap", params);
}

function bullet(key: WhyKey, params: Record<string, string | number>): WhyBullet {
  return { key, params };
}

/** The text in at most 300 code points: a longer one is cut on a code point and ends with "…". */
export function cut(text: string, max = PARAM_MAX): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

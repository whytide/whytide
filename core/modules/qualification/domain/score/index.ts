// The score, fit-v1 (docs/concepts.md "The score"): the fit computed in code from the stored verdicts
// and the ICP's criteria, never by the model (security §6), then the gate, the status and the tier.
// Pure. Changing a rule or a number here is a new scorer version with its own golden file
// (tests/fixtures/golden/), never an edit of fit-v1's.
import {
  type Criterion,
  DISQUALIFIERS,
  type Disqualifier,
  type Verdict,
} from "../../schemas/assess-fit.ts";

/** What a snapshot's scorer_version names. */
export const SCORER_VERSION = "fit-v1";
/** A verdict's points in tenths, balanced mode (F04 §4.3): integers, so that a sum is exact. */
const TENTHS: Readonly<Record<Verdict, number>> = {
  met: 10,
  partially_met: 5,
  unknown: 4,
  not_met: 0,
};
/** A must criterion at not_met caps the fit here. */
const MUST_CAP = 40;
/** The balanced gate. */
const GATE = 60;
/** The tier's threshold for hot; warm starts at the gate. A guess for alpha (docs/concepts.md). */
const HOT = 75;

export type Confidence = "high" | "medium" | "low";
export type Tier = "hot" | "warm" | "cool";
export type ScoreStatus = "qualified" | "not_qualified" | "needs_review";
/** What the scorer reads of an ICP criterion; icp's Criterion is one. */
export type ScoringCriterion = {
  readonly key: Criterion;
  readonly weight: number;
  readonly isMust: boolean;
  readonly enabled: boolean;
};
/** What the scorer reads of a verdict; a stored verdict row is one. */
export type ScoredVerdict = { readonly criterion: Criterion; readonly verdict: Verdict };
export type Fit = {
  readonly fit: number;
  readonly confidence: Confidence;
  readonly unknownCount: number;
};
export type Decision = {
  readonly status: ScoreStatus;
  readonly tier: Tier;
  /** The disqualifier that the lead's status_reason names, or null. */
  readonly reason: Disqualifier | null;
};

/**
 * The verdicts that count, in their order, each with its criterion's weight and must flag: those
 * whose criterion the ICP has enabled. A disabled criterion counts for nothing: no weight, no cap, no
 * review, no unknown.
 */
export function counting<V extends ScoredVerdict>(
  verdicts: readonly V[],
  criteria: readonly ScoringCriterion[],
): (V & { readonly weight: number; readonly isMust: boolean })[] {
  return verdicts.flatMap((verdict) => {
    const criterion = criteria.find(({ key, enabled }) => key === verdict.criterion && enabled);
    return criterion ? [{ ...verdict, weight: criterion.weight, isMust: criterion.isMust }] : [];
  });
}

/** A verdict's points, 0 to 1, as criterion_verdicts.points stores them. */
export function pointsOf(verdict: Verdict): number {
  return TENTHS[verdict] / 10;
}

/**
 * Fit = 100 × Σ(weight × points) / Σ weight over the verdicts that count, rounded half up; a must at
 * not_met caps it at 40; 0 when nothing counts. Confidence from the unknowns among them: high with at
 * most one, medium with two, low with three or more.
 */
export function computeFit(
  verdicts: readonly ScoredVerdict[],
  criteria: readonly ScoringCriterion[],
): Fit {
  const counted = counting(verdicts, criteria);
  const weight = counted.reduce((total, verdict) => total + verdict.weight, 0);
  const earned = counted.reduce((total, v) => total + v.weight * TENTHS[v.verdict], 0);
  const raw = weight === 0 ? 0 : Math.round((10 * earned) / weight);
  const capped = counted.some((verdict) => verdict.isMust && verdict.verdict === "not_met");
  const unknownCount = counted.filter((verdict) => verdict.verdict === "unknown").length;
  const confidence = unknownCount <= 1 ? "high" : unknownCount === 2 ? "medium" : "low";
  return { fit: capped ? Math.min(raw, MUST_CAP) : raw, confidence, unknownCount };
}

/**
 * The status and the tier: any disqualifier is not_qualified, its code the reason, whatever the fit;
 * below the gate not_qualified; at or above it needs_review when a must that counts is unknown or the
 * confidence is low, else qualified. The tier comes from the fit alone.
 */
export function decide(input: {
  readonly fit: number;
  readonly confidence: Confidence;
  readonly disqualifiers: readonly Disqualifier[];
  readonly verdicts: readonly ScoredVerdict[];
  readonly criteria: readonly ScoringCriterion[];
}): Decision {
  const { fit, confidence } = input;
  const tier = fit >= HOT ? "hot" : fit >= GATE ? "warm" : "cool";
  const reason = firstDisqualifier(input.disqualifiers);
  if (reason !== null || fit < GATE) return { status: "not_qualified", tier, reason };
  const counted = counting(input.verdicts, input.criteria);
  const mustUnknown = counted.some((verdict) => verdict.isMust && verdict.verdict === "unknown");
  const status = mustUnknown || confidence === "low" ? "needs_review" : "qualified";
  return { status, tier, reason };
}

/** Of several disqualifiers, the first in the closed list's order: one code, whatever the model's order. */
export function firstDisqualifier(codes: readonly Disqualifier[]): Disqualifier | null {
  return DISQUALIFIERS.find((code) => codes.includes(code)) ?? null;
}

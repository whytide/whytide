// A line of the golden set (README.md "The golden set"), pure: one reviewed lead as the evals read it,
// the assessment's input as the model saw it, the model's verdicts and the score, then the tester's
// decision. The person is the sha256 of its id; the line holds no other id, and no name or link.
import { createHash } from "node:crypto";
import type { LatestReview } from "@whytide/contacts";
import { z } from "zod";
import {
  type AssessFitInput,
  assessFitInput,
  CRITERIA,
  type CriterionVerdict,
  type Disqualifier,
} from "../../schemas/assess-fit.ts";
import type { ScoreStatus, Tier } from "../score/index.ts";

/** Where the input comes from: the decision record's raw prompt, or the stored records, rebuilt. */
export type InputFrom = "decision_record" | "rebuilt";

/** The snapshot the lead had when it was decided, as the line reads it. */
export type GoldenSnapshot = {
  readonly modelId: string;
  readonly promptVersion: number;
  readonly status: ScoreStatus | "assessed";
  readonly fitScore: number | null;
  readonly tier: Tier | null;
  readonly disqualifiers: readonly Disqualifier[];
  readonly verdicts: readonly CriterionVerdict[];
};

export type GoldenLine = {
  readonly person_sha256: string;
  readonly input_from: InputFrom;
  readonly input: AssessFitInput;
  readonly model_id: string | null;
  readonly prompt_version: number | null;
  readonly verdicts: CriterionVerdict[];
  readonly disqualifiers: Disqualifier[];
  readonly status: ScoreStatus | "assessed" | null;
  readonly fit: number | null;
  readonly tier: Tier | null;
  readonly decision: LatestReview["decision"];
  readonly reason_code: LatestReview["reasonCode"];
  readonly reason_text: string | null;
  readonly good_reason_text: string | null;
};

/**
 * The line of one reviewed lead: its snapshot at the decision, or none for a lead decided before an
 * assessment (null scores, no verdicts), with the input given and where it comes from.
 */
export function goldenLine(parts: {
  readonly review: LatestReview;
  readonly snapshot: GoldenSnapshot | null;
  readonly input: { readonly from: InputFrom; readonly value: AssessFitInput };
}): GoldenLine {
  const { review, snapshot, input } = parts;
  const verdicts = (snapshot?.verdicts ?? [])
    .map(({ criterion, verdict, evidence }) => ({ criterion, verdict, evidence }))
    .sort((a, b) => CRITERIA.indexOf(a.criterion) - CRITERIA.indexOf(b.criterion));
  return {
    person_sha256: createHash("sha256").update(review.personId).digest("hex"),
    input_from: input.from,
    input: input.value,
    model_id: snapshot?.modelId ?? null,
    prompt_version: snapshot?.promptVersion ?? null,
    verdicts,
    disqualifiers: [...(snapshot?.disqualifiers ?? [])],
    status: snapshot?.status ?? null,
    fit: snapshot?.fitScore ?? null,
    tier: snapshot?.tier ?? null,
    decision: review.decision,
    reason_code: review.reasonCode,
    reason_text: review.reasonText,
    good_reason_text: review.goodReasonText,
  };
}

/** A block of the user message as the ai package writes it: `<name>`, a line break, the value. */
const BLOCK = /<([a-z_]+)>\n([\s\S]*?)\n<\/\1>/g;

/**
 * The input a decision record's raw prompt carries: each of the input's blocks read back, a text as it
 * is and the others as JSON, `&lt;` as `<` again (the ai package writes every `<` so); a retry's
 * `<validation_error>` is left out. Null when the prompt is not the input's blocks.
 */
export function inputOfPrompt(prompt: string): AssessFitInput | null {
  const blocks = new Map<string, string>();
  for (const [, name = "", text = ""] of prompt.matchAll(BLOCK)) {
    blocks.set(name, text.replaceAll("&lt;", "<"));
  }
  const value: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(assessFitInput.shape)) {
    const text = blocks.get(name);
    if (text === undefined) return null;
    try {
      value[name] = schema instanceof z.ZodString ? text : JSON.parse(text);
    } catch {
      return null;
    }
  }
  const parsed = assessFitInput.safeParse(value);
  return parsed.success ? parsed.data : null;
}

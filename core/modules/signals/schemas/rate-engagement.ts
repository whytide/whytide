// The rating agent's input and output (agents/rate-engagement/README.md; gamma-p5-030). The input, a
// field per data block: the offer, Company Knowledge's one-liner, products and pain points, and up to
// RATE_BATCH_SIZE events, each its kind, the person's role, their own words and the post's excerpt,
// scrubbed; never a name, a profile URL, a headline, a company or a member reference. The output:
// one rating per event, by its index.
import { z } from "zod";
import { RATE_BATCH_SIZE } from "../domain/constants.ts";

export const RATE_ENGAGEMENT = "signals.rate-engagement";
/** A rationale's characters at most. */
export const RATIONALE_MAX = 200;
/** qualification's INTENT_CLASSES, in its order (tests/rate.test.ts checks they agree). */
export const RATE_CLASSES = [
  "seeking_recommendation",
  "pain_or_complaint",
  "evaluating_or_comparing",
  "praising_competitor",
  "other",
  "generic_praise",
  "self_promotion",
  "job_seeking",
] as const;
/** A role as the model reads it: a like and a repost are reactions. */
export const RATE_ROLES = ["author", "comment", "reaction"] as const;

const item = z.string().max(200);
/** An excerpt is 500 characters; its placeholders may lengthen it. */
const words = z.string().max(1_000).nullable();
const index = z.number().int().min(1).max(RATE_BATCH_SIZE);

export const rateEngagementInput = z.strictObject({
  offer: z.strictObject({
    oneLiner: item,
    products: z.array(item).max(20),
    painPoints: z.array(item).max(20),
  }),
  events: z
    .array(
      z.strictObject({
        index,
        kind: z.string().max(64),
        role: z.enum(RATE_ROLES),
        words,
        post: words,
      }),
    )
    .min(1)
    .max(RATE_BATCH_SIZE),
});
export type RateEngagementInput = z.output<typeof rateEngagementInput>;

export const rateEngagementOutput = z.strictObject({
  ratings: z
    .array(
      z.strictObject({
        index,
        relevance: z.number().min(0).max(1),
        rationale: z.string().trim().min(1).max(RATIONALE_MAX),
        intentClass: z.enum(RATE_CLASSES).nullable(),
      }),
    )
    .min(1)
    .max(RATE_BATCH_SIZE),
});
export type RateEngagementOutput = z.output<typeof rateEngagementOutput>;

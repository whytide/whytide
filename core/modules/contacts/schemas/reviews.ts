// The requests and answers of contacts' review routes (README.md "Routes"), from which the api
// builds its OpenAPI document: a decision, a lead's history and a week's summary.
import { z } from "zod";
import { TIERS } from "../domain/lead.ts";
import { REASON_CODES, REVIEW_DECISIONS, type ReasonCode } from "../domain/review/rules.ts";

export const reviewBody = z.strictObject({
  decision: z.enum(REVIEW_DECISIONS),
  /** Not a fit's code, required for it. */
  reasonCode: z.enum(REASON_CODES).optional(),
  /** Not a fit's words, required for `other`. */
  reasonText: z.string().max(500).optional(),
  /** Good lead's words, required for it. */
  goodReasonText: z.string().max(200).optional(),
});
export type ReviewBody = z.infer<typeof reviewBody>;

/** A decision: its kind's fields, the lead's snapshot, fit and tier at the time, who and when. */
export const reviewResponse = z.strictObject({
  id: z.string(),
  personId: z.string(),
  decision: z.enum(REVIEW_DECISIONS),
  reasonCode: z.enum(REASON_CODES).nullable(),
  reasonText: z.string().nullable(),
  goodReasonText: z.string().nullable(),
  snapshotId: z.string().nullable(),
  fitAtDecision: z.int().nullable(),
  tierAtDecision: z.enum(TIERS).nullable(),
  decidedBy: z.string(),
  decidedAt: z.string(),
});
export type ReviewResponse = z.infer<typeof reviewResponse>;
/** The lead's decisions, newest first. */
export const reviewHistory = z.strictObject({ reviews: z.array(reviewResponse) });
export type ReviewHistory = z.infer<typeof reviewHistory>;

export const summaryQuery = z.strictObject({
  /** An ISO week, `2026-W43`, in UTC. */
  week: z.string().regex(/^\d{4}-W\d{2}$/),
});
export type SummaryQuery = z.infer<typeof summaryQuery>;
const count = z.int().min(0);
const reasons = Object.fromEntries(REASON_CODES.map((code) => [code, count]));
/** The week's decisions, the latest per lead, and its top twenty qualified leads by fit. */
export const reviewSummary = z.strictObject({
  decided: count,
  goodLeads: count,
  notAFit: count,
  top20: z.strictObject({
    count,
    goodLeads: count,
    reviewed: count,
    rate: z.number().min(0).max(1).nullable(),
  }),
  /** Every code, with how many of the week's Not a fit name it. */
  byReason: z.strictObject(reasons as Record<ReasonCode, typeof count>),
});
export type ReviewSummaryResponse = z.infer<typeof reviewSummary>;

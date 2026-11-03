// The requests and answers of contacts' lead routes (README.md "Routes"), from which the api
// builds its OpenAPI document: the lead's fields with the person's, never a provider's id.
import { z } from "zod";
import {
  CONFIDENCES,
  LEAD_SORTS,
  QUALIFICATION_STATUSES,
  SOURCE_KINDS,
  TIERS,
} from "../domain/lead.ts";
import { REASON_CODES, REVIEW_DECISIONS, REVIEW_FILTERS } from "../domain/review/rules.ts";
import { personResponse } from "./persons.ts";

const lead = {
  personId: z.string(),
  qualificationStatus: z.enum(QUALIFICATION_STATUSES),
  /** The first source's kind. */
  sourceLabel: z.enum(SOURCE_KINDS),
  /**
   * Every source, in the order they came: `ref` is the id of the import job or the signal source;
   * `label` and `url`, a signal source's label and post, where its module gave them.
   */
  sources: z.array(
    z.strictObject({
      kind: z.enum(SOURCE_KINDS),
      ref: z.string(),
      at: z.string(),
      label: z.string().optional(),
      url: z.string().optional(),
    }),
  ),
  firstSourceAt: z.string(),
  fitScore: z.int().nullable(),
  fitConfidence: z.enum(CONFIDENCES).nullable(),
  tier: z.enum(TIERS).nullable(),
  currentScoreSnapshotId: z.string().nullable(),
  /** Up to three bullets, a message key and its values each. */
  why: z.array(
    z.strictObject({
      key: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    }),
  ),
  hardFilterReason: z.string().nullable(),
  statusReason: z.string().nullable(),
  icpVersionScored: z.int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The latest review decision and its time; null until the first. */
  reviewStatus: z.enum(REVIEW_DECISIONS).nullable(),
  reviewedAt: z.string().nullable(),
};
/**
 * A lead of the list: its fields, its latest Not a fit's reason, and the person's name, title,
 * company and URL.
 */
export const leadSummary = z.strictObject({
  ...lead,
  /** The reason code of the latest decision when it is Not a fit; null otherwise. */
  reviewReasonCode: z.enum(REASON_CODES).nullable(),
  person: personResponse.pick({
    firstName: true,
    lastName: true,
    title: true,
    companyName: true,
    linkedinUrl: true,
  }),
});
export const leadPage = z.strictObject({
  leads: z.array(leadSummary),
  nextCursor: z.string().nullable(),
});
export type LeadPage = z.infer<typeof leadPage>;
/** One lead: its fields and the person's business fields with the provenance of each. */
export const leadResponse = z.strictObject({ ...lead, person: personResponse });
export type LeadResponse = z.infer<typeof leadResponse>;

const count = z.int().min(0);
/** How many of the workspace's leads are in each status. */
export const leadCounts = z.strictObject({
  counts: z.strictObject({
    pending: count,
    hard_filtered: count,
    qualified: count,
    not_qualified: count,
    needs_review: count,
    ai_failed: count,
  }),
});
export type LeadCounts = z.infer<typeof leadCounts>;

export const leadListQuery = z.strictObject({
  status: z.enum(QUALIFICATION_STATUSES).optional(),
  tier: z.enum(TIERS).optional(),
  /** `unreviewed`: the leads without a review decision. */
  review: z.enum(REVIEW_FILTERS).optional(),
  /** Descending fit, no score last; newest first; or no decision first, then by fit. */
  sort: z.enum(LEAD_SORTS).default("fit"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** The `nextCursor` of the page before, in the same sort. */
  cursor: z.string().min(1).max(200).optional(),
});
export type LeadListQuery = z.infer<typeof leadListQuery>;
export const leadParams = z.strictObject({ personId: z.string().min(1).max(64) });
/** The list's view the neighbours are read in: its filters and its sort. */
export const neighboursQuery = leadListQuery.pick({
  status: true,
  tier: true,
  review: true,
  sort: true,
});
export type NeighboursQuery = z.infer<typeof neighboursQuery>;
/** The person ids of the leads just before and just after one in that view; null at either end. */
export const leadNeighbours = z.strictObject({
  previous: z.string().nullable(),
  next: z.string().nullable(),
});
export type LeadNeighbours = z.infer<typeof leadNeighbours>;

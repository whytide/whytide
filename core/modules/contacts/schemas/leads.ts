// The requests and answers of contacts' lead routes (README.md "Routes"), from which the api
// builds its OpenAPI document: the lead's fields with the person's, never a provider's id.
import { z } from "zod";
import { SOURCE_REF } from "../domain/constants.ts";
import {
  CONFIDENCES,
  LEAD_SORTS,
  QUALIFICATION_STATUSES,
  SOURCE_KINDS,
  TIERS,
} from "../domain/lead.ts";
import { OUTREACH_STATUSES, STATUS_ACTORS } from "../domain/outreach/constants.ts";
import { REASON_CODES, REVIEW_DECISIONS, REVIEW_FILTERS } from "../domain/review/rules.ts";
import { SUPPRESSION_REASONS } from "../domain/suppression/constants.ts";
import { personResponse } from "./persons.ts";

const lead = {
  personId: z.string(),
  qualificationStatus: z.enum(QUALIFICATION_STATUSES),
  /** The first source's kind. */
  sourceLabel: z.enum(SOURCE_KINDS),
  /**
   * Every source, in the order they came: `ref` is the id of the import job, the signal source or,
   * for `manual`, the member who added the lead by hand; `label` and `url`, a signal source's label
   * and post, where its module gave them.
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
  /** The audience the decision was judged against (an ICP's id); null before audiences, or none. */
  icpIdScored: z.string().nullable(),
  icpVersionScored: z.int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The latest review decision and its time; null until the first. */
  reviewStatus: z.enum(REVIEW_DECISIONS).nullable(),
  reviewedAt: z.string().nullable(),
  /** Where the lead is on the way to outreach; Approve and campaigns move it. */
  outreachStatus: z.enum(OUTREACH_STATUSES),
  /** A code: why the latest change happened, such as opted_out; null when none was given. */
  outreachReason: z.string().nullable(),
};
/**
 * A lead of the list: its fields, its latest Not a fit's reason, and the person's name, title,
 * company, company id (the row menu's Never contact their company) and URL.
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
    companyId: true,
    linkedinUrl: true,
  }),
});
export const leadPage = z.strictObject({
  leads: z.array(leadSummary),
  nextCursor: z.string().nullable(),
});
export type LeadPage = z.infer<typeof leadPage>;
/**
 * One lead: its fields, the person's business fields with the provenance of each, and why the
 * person may not be contacted now, or null (suppressionOf without a new enrollment).
 */
export const leadResponse = z.strictObject({
  ...lead,
  person: personResponse,
  suppression: z.strictObject({ reason: z.enum(SUPPRESSION_REASONS) }).nullable(),
});
export type LeadResponse = z.infer<typeof leadResponse>;
/**
 * A member's edit of the lead's person (lead-fields-edit): any of the six profile fields, an empty
 * one to clear it. Their rules (trimmed, the source's limits, the first name kept) are the command's
 * (domain/rules.ts), so that a refusal is contacts_input_invalid naming the fields.
 */
export const leadFieldsBody = z.strictObject({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  headline: z.string().optional(),
  title: z.string().optional(),
  companyName: z.string().optional(),
  locationText: z.string().optional(),
});
export type LeadFieldsBody = z.infer<typeof leadFieldsBody>;
/**
 * A member's lead by hand (lead-manual-create): the LinkedIn profile URL and the six profile
 * fields, the first name required. Their rules (the URL normalized, each value trimmed and within
 * the source's limit, an empty optional one none) are the command's (domain/rules.ts), so that a
 * refusal is linkedin_url_invalid, or contacts_input_invalid naming the fields, a first name left
 * out too.
 */
export const leadCreateBody = leadFieldsBody.extend({ linkedinUrl: z.string() });
export type LeadCreateBody = z.infer<typeof leadCreateBody>;

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
  /** A source's `ref`, an import job's id or a signal source's: the leads with a source of it. */
  source: z.string().regex(SOURCE_REF, "a source's id").optional(),
  status: z.enum(QUALIFICATION_STATUSES).optional(),
  tier: z.enum(TIERS).optional(),
  /** `unreviewed`: the leads without a review decision. */
  review: z.enum(REVIEW_FILTERS).optional(),
  /** The outreach status; `status` stays qualification's. */
  outreach: z.enum(OUTREACH_STATUSES).optional(),
  /** Descending fit, no score last; newest first; or no decision first, then by fit. */
  sort: z.enum(LEAD_SORTS).default("fit"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** The `nextCursor` of the page before, in the same sort. */
  cursor: z.string().min(1).max(200).optional(),
});
export type LeadListQuery = z.infer<typeof leadListQuery>;
export const leadParams = z.strictObject({ personId: z.string().min(1).max(64) });
/** The counts of the leads of one source, as the list's `source`; every lead without it. */
export const leadCountsQuery = leadListQuery.pick({ source: true });
export type LeadCountsQuery = z.infer<typeof leadCountsQuery>;
/** The list's view the neighbours are read in: its filters and its sort. */
export const neighboursQuery = leadListQuery.pick({
  source: true,
  status: true,
  tier: true,
  review: true,
  outreach: true,
  sort: true,
});
export type NeighboursQuery = z.infer<typeof neighboursQuery>;
/** The person ids of the leads just before and just after one in that view; null at either end. */
export const leadNeighbours = z.strictObject({
  previous: z.string().nullable(),
  next: z.string().nullable(),
});
export type LeadNeighbours = z.infer<typeof leadNeighbours>;
/** Approve's answer: the lead's outreach status, `approved`. */
export const approveResponse = z.strictObject({ outreachStatus: z.enum(OUTREACH_STATUSES) });
export type ApproveResponse = z.infer<typeof approveResponse>;
/** A lead's status changes, newest first, the hundred newest at most. */
export const statusChangesResponse = z.strictObject({
  changes: z.array(
    z.strictObject({
      id: z.string(),
      personId: z.string(),
      fromStatus: z.enum(OUTREACH_STATUSES),
      toStatus: z.enum(OUTREACH_STATUSES),
      /** The campaign's template that moved the lead, for in_campaign and finished. */
      templateId: z.string().nullable(),
      /** A code, such as opted_out. */
      reason: z.string().nullable(),
      actorType: z.enum(STATUS_ACTORS),
      /** The user's id; null for the system. */
      actorId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type StatusChangesResponse = z.infer<typeof statusChangesResponse>;

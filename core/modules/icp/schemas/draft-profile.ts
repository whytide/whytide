// The drafter's data, version 1 (agents/draft-profile/README.md): the input, the company's accepted
// content fields and the admin's brief; the output, the ICP's name and targeting fields, the closed
// lists as enums. A key the output schema does not declare is dropped when parsed (security §6).
import { z } from "zod";
import { COUNTRIES, LIMITS, SENIORITIES, SIZE_RANGES } from "../domain/lists.ts";

/** The task's name in the agent registry. */
export const DRAFT_PROFILE = "icp.draft-profile";

/** Company Knowledge's content fields as the drafter reads them: no website, id, source or tone. */
const company = z.object({
  oneLiner: z.string(),
  longDescription: z.string(),
  products: z.array(z.string()),
  painPoints: z.array(z.string()),
  featuresBenefits: z.array(z.string()),
  /** The proof points' texts, without their pages. */
  proofPoints: z.array(z.string()),
  competitors: z.array(z.string()),
});
export type DraftCompany = z.output<typeof company>;

/** One field per data block: the company as JSON, the brief as text, empty when none. */
export const draftProfileInput = z.object({ company, brief: z.string().max(LIMITS.brief) });
export type DraftProfileInput = z.output<typeof draftProfileInput>;

/** The fields saveIcp takes; the lengths, counts and duplicates are the gate's (domain/draft-gates.ts). */
export const draftProfileOutput = z.object({
  name: z.string(),
  titles: z.array(z.string()),
  seniorities: z.array(z.enum(SENIORITIES)),
  industries: z.array(z.string()),
  sizeRanges: z.array(z.enum(SIZE_RANGES)),
  countries: z.array(z.enum(COUNTRIES as [string, ...string[]])),
  mustHaves: z.string(),
  disqualifiers: z.string(),
});
export type DraftProfileOutput = z.output<typeof draftProfileOutput>;

/** icps.pending_draft: the output with the model, the prompt version and the decision record. */
export const pendingDraft = z.strictObject({
  model: z.string(),
  promptVersion: z.number().int(),
  decisionRecordId: z.string(),
  fields: draftProfileOutput,
});
export type PendingDraft = z.output<typeof pendingDraft>;

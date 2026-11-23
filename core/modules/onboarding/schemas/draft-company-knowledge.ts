// The drafter's data, version 1 (agents/draft-company-knowledge/README.md): the input, the pages a
// Draft read; the output, every content field with its page and a quote of it per value. A key the
// output schema does not declare is dropped when parsed: the record never takes it (security §6).
import { z } from "zod";
import { DOCUMENT_LIMITS } from "../domain/constants.ts";

/** The task's name in the agent registry. */
export const DRAFT_COMPANY_KNOWLEDGE = "onboarding.draft-company-knowledge";

/**
 * The pages in the order read, then the documents: what they say, never an id or a time. Each text
 * whole, as stored: at most the 50,000 characters a page and a document keep (DOCUMENT_LIMITS.text,
 * the fetch's FETCH_LIMITS.text).
 */
const text = z.string().max(DOCUMENT_LIMITS.text);
export const draftInput = z.object({
  pages: z.array(z.object({ url: z.string(), title: z.string(), text })).min(1),
});
export type DraftInput = z.output<typeof draftInput>;

/** A drafted value, the page it comes from (one of the pages' `url`) and words of that page. */
const cited = z.object({ text: z.string(), sourceUrl: z.string(), quote: z.string() });
export type Cited = z.output<typeof cited>;

/** Every content field (domain/fields.ts): a text field null and a list empty when no page says it. */
export const draftOutput = z.object({
  oneLiner: cited.nullable(),
  longDescription: cited.nullable(),
  products: z.array(cited),
  painPoints: z.array(cited),
  featuresBenefits: z.array(cited),
  proofPoints: z.array(cited),
  competitors: z.array(cited),
  tone: cited.nullable(),
});
export type DraftOutput = z.output<typeof draftOutput>;

/** company_knowledge.pending_draft: the output with the model, prompt version and decision record. */
export const pendingDraft = z.strictObject({
  model: z.string(),
  promptVersion: z.number().int(),
  decisionRecordId: z.string(),
  fields: draftOutput,
});
export type PendingDraft = z.output<typeof pendingDraft>;

// The evidence route's params and answer (README.md "API"), from which the api host builds the
// OpenAPI document: a person's events, newest first, each with its evidence, and the attribution of
// the person's lead.
import { z } from "zod";

export const evidenceParams = z.strictObject({ personId: z.string().min(1).max(64) });

const evidence = z.strictObject({
  /** The post. */
  url: z.string(),
  /** The first 500 characters of the person's comment; null for a reaction. */
  excerpt: z.string().nullable(),
  commentText: z.string().nullable(),
  reaction: z.string(),
  author: z.string(),
  capturedAt: z.iso.datetime(),
  /** Set once alpha-p10-020 reduced it to a summary. */
  reducedAt: z.iso.datetime().nullable(),
});
/**
 * One of the lead's sources (contacts' kinds): a signal source's label, null once it is deleted; an
 * import's file name, null for a lead imported before its leads were named; a member's by hand
 * (`manual`, lead-manual-create), null.
 */
const leadSource = z.strictObject({
  kind: z.enum(["signal", "imported", "manual"]),
  label: z.string().nullable(),
});
/**
 * What a Web research event adds (gamma-wr-061): the page the person was found on and the found company's
 * reasons as gamma-wr-050 kept them, each a line about the company with its quote and the page it is on.
 * Absent for every other kind. `company` is null when the found company is gone.
 */
const research = z.strictObject({
  url: z.string(),
  /**
   * Present when the person was not found as a page printed them: `search`, the LinkedIn profile found by
   * a web search on their name (gamma-wr-070); `managers`, the person found by the search of the company's
   * managers (gamma-wr-090), whose `url` is then the company's site and `title` the title of the result
   * that gave them (absent once the evidence is reduced).
   */
  foundBy: z.enum(["search", "managers"]).optional(),
  title: z.string().optional(),
  company: z
    .strictObject({
      name: z.string(),
      domain: z.string(),
      reasons: z.array(
        z.strictObject({
          kind: z.string(),
          criterion: z.string().nullable(),
          line: z.string(),
          quote: z.string(),
          url: z.string(),
        }),
      ),
    })
    .nullable(),
});
export const evidenceResponse = z.strictObject({
  events: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.string(),
      /** Null once the source, or its run, is deleted: the event stays. */
      sourceId: z.string().nullable(),
      sourceLabel: z.string().nullable(),
      runId: z.string().nullable(),
      occurredAt: z.iso.datetime(),
      evidence: evidence.nullable(),
      research: research.optional(),
    }),
  ),
  /** The lead's first source and the others, in contacts' order; null for a person without a lead. */
  attribution: z.strictObject({ first: leadSource, others: z.array(leadSource) }).nullable(),
});
export type EvidenceResponse = z.infer<typeof evidenceResponse>;

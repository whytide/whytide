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
/** One of the lead's sources (contacts' kinds): a signal source's label, null once it is deleted. */
const leadSource = z.strictObject({
  kind: z.enum(["signal", "imported"]),
  label: z.string().nullable(),
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
    }),
  ),
  /** The lead's first source and the others, in contacts' order; null for a person without a lead. */
  attribution: z.strictObject({ first: leadSource, others: z.array(leadSource) }).nullable(),
});
export type EvidenceResponse = z.infer<typeof evidenceResponse>;

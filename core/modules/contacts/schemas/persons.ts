// The requests and answers of contacts' person routes (README.md "Routes"), from which the api builds
// its OpenAPI document: business fields and the provenance of each, never a provider's id.
import { z } from "zod";
import { PROVENANCE_SOURCES, PROVIDER_NAME } from "../domain/provenance.ts";

/** Where a field's value came from: a source, or `member` for a value a member typed. */
const provenance = z.strictObject({
  source: z.enum(PROVENANCE_SOURCES),
  provider: z.string().regex(PROVIDER_NAME).nullable(),
  at: z.string(),
});
export const personResponse = z.strictObject({
  id: z.string(),
  /** Null for a person known by an email address alone, whose address no route answers (gamma-rf-050). */
  linkedinUrl: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  headline: z.string().nullable(),
  title: z.string().nullable(),
  companyName: z.string().nullable(),
  companyId: z.string().nullable(),
  locationText: z.string().nullable(),
  locationCountry: z.string().nullable(),
  /** Each field that has a value, or that a member cleared: where it came from and when. */
  provenance: z.record(z.string(), provenance),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PersonResponse = z.infer<typeof personResponse>;
export const personPage = z.strictObject({
  persons: z.array(personResponse),
  nextCursor: z.string().nullable(),
});
export type PersonPage = z.infer<typeof personPage>;

export const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** The `nextCursor` of the page before. */
  cursor: z.string().min(1).max(64).optional(),
});
export type ListQuery = z.infer<typeof listQuery>;
export const personParams = z.strictObject({ id: z.string().min(1).max(64) });

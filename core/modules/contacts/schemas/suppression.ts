// The requests and answers of contacts' never-contact routes (README.md "Routes"), from which the api
// builds its OpenAPI document: the body that adds an entry, an entry with what it names, and the
// list's page. Never an entry's hash.
import { z } from "zod";
import {
  ADD_LAYERS,
  SUPPRESSION_CHANNELS,
  SUPPRESSION_KINDS,
  SUPPRESSION_LAYERS,
  SUPPRESSION_MATCH_TYPES,
  SUPPRESSION_RELATIONSHIPS,
  SUPPRESSION_SOURCES,
  SUPPRESSION_VALUE_MAX,
} from "../domain/suppression/constants.ts";
import { listQuery, personParams } from "./persons.ts";

/**
 * One target: the person's or the company's id, or a value; `layer` opt_out for a person only, on
 * every channel; `relationship` for a company by its domain only.
 */
export const suppressionBody = z.strictObject({
  kind: z.enum(SUPPRESSION_KINDS),
  personId: z.string().optional(),
  companyId: z.string().optional(),
  /**
   * A profile URL, else an email address (gamma-rf-040), for a person; a company page URL, else a
   * domain, for a company.
   */
  value: z.string().max(SUPPRESSION_VALUE_MAX).optional(),
  /** blocklist when absent; opt_out records a person's opt-out by hand. */
  layer: z.enum(ADD_LAYERS).optional(),
  /** The channel the entry stops, all when absent; an opt-out's is all. */
  channel: z.enum(SUPPRESSION_CHANNELS).optional(),
  /** Excludes the company as a customer or a competitor: a relationship entry on its domain. */
  relationship: z.enum(SUPPRESSION_RELATIONSHIPS).optional(),
});
export type SuppressionBody = z.infer<typeof suppressionBody>;

/**
 * An active entry, and the person or company of the workspace it names, with its name: an email
 * entry's person is the one who holds its address.
 */
export const suppressionEntry = z.strictObject({
  id: z.string(),
  layer: z.enum(SUPPRESSION_LAYERS),
  matchType: z.enum(SUPPRESSION_MATCH_TYPES),
  /** The profile or company page of a linkedin_url entry; null once the person is erased. */
  linkedinUrl: z.string().nullable(),
  domain: z.string().nullable(),
  /** The address of an email entry (gamma-rf-040); null once the person who held it is erased. */
  email: z.string().nullable(),
  channel: z.enum(SUPPRESSION_CHANNELS),
  /** customer or competitor on a relationship entry; null on any other. */
  relationship: z.enum(SUPPRESSION_RELATIONSHIPS).nullable(),
  source: z.enum(SUPPRESSION_SOURCES),
  reason: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  personId: z.string().nullable(),
  companyId: z.string().nullable(),
  displayName: z.string().nullable(),
});
export type SuppressionEntryResponse = z.infer<typeof suppressionEntry>;
export const suppressionPage = z.strictObject({
  entries: z.array(suppressionEntry),
  nextCursor: z.string().nullable(),
});
export type SuppressionPage = z.infer<typeof suppressionPage>;

/** The list's page size, 1 to 100 (50), and the `nextCursor` of the page before: the persons'. */
export const suppressionQuery = listQuery;
export type SuppressionQuery = z.infer<typeof suppressionQuery>;
/** An entry's id, as the persons' route takes one. */
export const suppressionParams = personParams;

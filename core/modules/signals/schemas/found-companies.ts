// The Companies found routes' query and answers (README.md "API"; gamma-wr-110), from which the api host
// builds the OpenAPI document. The list's filters are a source, an agent and a verdict; with no verdict it
// holds `fit` and `unsure`. The CSV takes the same filters and no page.
import { z } from "zod";
import {
  FOUND_PAGE_DEFAULT,
  FOUND_PAGE_MAX,
  REASON_KINDS,
  VERDICTS,
} from "../domain/research/constants.ts";

const id = z.string().min(1).max(64);

/** The view a member filters to: a source, an agent (its sources) and a verdict. */
export const foundFilterQuery = z.strictObject({
  sourceId: id.optional(),
  playbookId: id.optional(),
  verdict: z.enum(VERDICTS).optional(),
});
export type FoundFilterQuery = z.infer<typeof foundFilterQuery>;

export const foundListQuery = foundFilterQuery.extend({
  limit: z.coerce.number().int().min(1).max(FOUND_PAGE_MAX).default(FOUND_PAGE_DEFAULT),
  /** The `nextCursor` of the page before. */
  cursor: z.string().min(1).max(200).optional(),
});
export type FoundListQuery = z.infer<typeof foundListQuery>;

export const foundParams = z.strictObject({ id });

/** One reason: what a page shows of the company, its words on the page, its address and the date read. */
const reason = z.strictObject({
  kind: z.enum(REASON_KINDS),
  criterion: z.string().optional(),
  answer: z.enum(["shown", "contradicted"]),
  line: z.string(),
  quote: z.string(),
  url: z.string(),
  readAt: z.iso.datetime(),
});

export const foundCompanyResponse = z.strictObject({
  id: z.string(),
  /** Null once the source is deleted; the company stays, under `sourceLabel`. */
  sourceId: z.string().nullable(),
  sourceLabel: z.string(),
  name: z.string(),
  domain: z.string(),
  website: z.string(),
  verdict: z.enum(VERDICTS),
  /** Whether a member set the verdict (Not a fit), who and when; the run never replaces it. */
  markedByMember: z.boolean(),
  markedBy: z.string().nullable(),
  markedAt: z.iso.datetime().nullable(),
  reasons: z.array(reason),
  country: z.string().nullable(),
  town: z.string().nullable(),
  state: z.string().nullable(),
  /** The page that led to the company, and the source type of the search that found it (null for a start page). */
  pageUrl: z.string(),
  placeId: z.string().nullable(),
  email: z.string().nullable(),
  phones: z.array(z.string()),
  postalAddress: z.string().nullable(),
  judgedAt: z.iso.datetime(),
  /** The leads found there (gamma-wr-060): the first ones with their name and title, and how many in all. */
  leads: z.array(
    z.strictObject({
      personId: z.string(),
      name: z.string().nullable(),
      title: z.string().nullable(),
    }),
  ),
  leadCount: z.number().int(),
});
export type FoundCompanyResponse = z.infer<typeof foundCompanyResponse>;

export const foundListResponse = z.strictObject({
  companies: z.array(foundCompanyResponse),
  nextCursor: z.string().nullable(),
});
export type FoundListResponse = z.infer<typeof foundListResponse>;

// The research plan agent's input and output (agents/research-plan/README.md; gamma-wr-040). The
// input, a field per data block: Company Knowledge's offer, the run's audience, the source's own
// fields, the list of source types and the queries the source asked before; never a name, an email
// address, a link or a phone number. The output: the trade's words by language, the source types to
// use and the queries, each with its source type, a country and a language; from prompt version 4 also the
// words of the audience's roles by language. The gates that refuse a
// part of it, a source type off the list, a country or a language out of bounds, a query not to be
// asked, are in code (domain/research/checks.ts); the schema bounds the shape only.
import { z } from "zod";
import {
  ASKED_IN_INPUT_MAX,
  FOUND_TOWNS_MAX,
  INPUT_ITEM_MAX,
  INPUT_ITEMS_MAX,
  INPUT_TEXT_MAX,
  NOT_FIT_DOMAIN_CHARS,
  NOT_FIT_IN_INPUT_MAX,
  NOT_FIT_NAME_CHARS,
  PAGE_KINDS,
  PLACE_TEXT_MAX,
  PLACE_WORD_CHARS,
  PLAN_PLACES_MAX,
  PLAN_QUERIES_MAX,
  PLAN_QUERY_INPUT_CHARS,
  ROLE_WORD_MAX_CHARS,
  ROLE_WORDS_PER_LANGUAGE_MAX,
  WORD_LANGUAGES_MAX,
  WORD_MAX_CHARS,
  WORDS_PER_LANGUAGE_MAX,
} from "../domain/research/constants.ts";

export const RESEARCH_PLAN = "signals.research-plan";

const text = z.string().max(INPUT_TEXT_MAX);
const item = z.string().max(INPUT_ITEM_MAX);
const items = z.array(item).max(INPUT_ITEMS_MAX);
/** A code of a country or a language as the input and the answer carry it; the gates check its form. */
const code = z.string().max(8);

/** The companies a group led to, by verdict (gamma-wr-051). */
const verdictCounts = z.strictObject({
  fit: z.int().min(0),
  notFit: z.int().min(0),
  unsure: z.int().min(0),
});

export const researchPlanInput = z.strictObject({
  knowledge: z.strictObject({
    oneLiner: text,
    longDescription: text,
    products: items,
    painPoints: items,
    featuresBenefits: items,
    competitors: items,
  }),
  audience: z.strictObject({
    industries: items,
    sizeRanges: items,
    countries: z.array(code).max(INPUT_ITEMS_MAX),
    titles: items,
    seniorities: items,
    mustHaves: text,
    disqualifiers: text,
  }),
  source: z.strictObject({
    focus: text,
    region: text,
    /** The languages the source names, ISO 639-1; none: the plan picks the buyers' languages. */
    languages: z.array(code).max(WORD_LANGUAGES_MAX),
  }),
  places: z
    .array(
      z.strictObject({
        id: z.string().max(64),
        shows: z.string().max(PLACE_TEXT_MAX),
        finding: z.string().max(PLACE_TEXT_MAX),
        pageKind: z.enum(PAGE_KINDS),
      }),
    )
    .min(1)
    .max(PLAN_PLACES_MAX * 2),
  asked: z
    .array(
      z.strictObject({
        place: z.string().max(64),
        country: code,
        language: code,
        text: z.string().max(PLAN_QUERY_INPUT_CHARS),
        /** How many companies the query led to, by verdict; from prompt version 2. */
        found: verdictCounts.optional(),
      }),
    )
    .max(ASKED_IN_INPUT_MAX),
  /**
   * What the source's earlier runs found (prompt version 2): the companies each source type led to, by
   * verdict, and the towns and states of the fitting ones. Counts and place words only: never a
   * company's name, its link or a quote.
   */
  found: z
    .strictObject({
      places: z
        .array(z.strictObject({ place: z.string().max(64), ...verdictCounts.shape }))
        .max(PLAN_PLACES_MAX * 2),
      towns: z
        .array(
          z.strictObject({
            country: code.nullable(),
            town: z.string().max(PLACE_WORD_CHARS),
            state: z.string().max(PLACE_WORD_CHARS).nullable(),
            companies: z.int().min(1),
          }),
        )
        .max(FOUND_TOWNS_MAX),
    })
    .optional(),
  /**
   * The source's own companies a member marked Not a fit (prompt version 3, gamma-wr-110), the newest
   * mark first: untrusted data, a name a page gave and the company's site's host, never a link, a quote
   * or a person.
   */
  not_fit: z
    .array(
      z.strictObject({
        name: z.string().max(NOT_FIT_NAME_CHARS),
        domain: z.string().max(NOT_FIT_DOMAIN_CHARS),
        country: code.nullable(),
        town: z.string().max(PLACE_WORD_CHARS).nullable(),
      }),
    )
    .max(NOT_FIT_IN_INPUT_MAX)
    .optional(),
});
export type ResearchPlanInput = z.output<typeof researchPlanInput>;

export const researchPlanOutput = z.strictObject({
  words: z
    .array(
      z.strictObject({
        language: code,
        words: z.array(z.string().max(WORD_MAX_CHARS)).max(WORDS_PER_LANGUAGE_MAX),
      }),
    )
    .max(WORD_LANGUAGES_MAX),
  /**
   * The words of the audience's roles by language, as people of the trade say them (prompt version 4,
   * gamma-wr-090); a plan of an earlier version gives none. The search of a company's managers asks them.
   */
  roleWords: z
    .array(
      z.strictObject({
        language: code,
        words: z
          .array(z.string().max(ROLE_WORD_MAX_CHARS * 3))
          .max(ROLE_WORDS_PER_LANGUAGE_MAX * 2),
      }),
    )
    .max(WORD_LANGUAGES_MAX)
    .optional(),
  places: z.array(z.string().max(64)).max(PLAN_PLACES_MAX),
  queries: z
    .array(
      z.strictObject({
        place: z.string().max(64),
        country: code,
        language: code,
        text: z.string().max(PLAN_QUERY_INPUT_CHARS),
      }),
    )
    .max(PLAN_QUERIES_MAX),
});
export type ResearchPlanOutput = z.output<typeof researchPlanOutput>;

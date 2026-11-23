// The company judge's input and output (agents/research-judge-company/README.md; gamma-wr-050). The
// input, a field per data block: what the source looks for, the audience's must-haves, disqualifiers,
// industries, sizes and countries, what the page that named the company says of it, and the pages of
// the company's own site. The output answers closed questions: for the focus, each must-have and each
// disqualifier `shown`, `contradicted` or `not_stated`, with one line and a quote of the page for the
// first two; where the site puts the company; whether it is a business of one person; and how the site
// says it can be reached. The verdict is never the model's: the gates and the rule are in code
// (domain/research/judge-checks.ts, verdict.ts).
import { z } from "zod";
import {
  ANSWERS,
  CRITERIA_MAX,
  CRITERION_CHARS,
  EMAIL_CHARS,
  INPUT_ITEM_MAX,
  INPUT_ITEMS_MAX,
  INPUT_TEXT_MAX,
  PHONE_CHARS,
  PHONES_MAX,
  PLACE_WORD_CHARS,
  POSTAL_CHARS,
  REASON_LINE_CHARS,
  REASON_QUOTE_CHARS,
  SITE_PAGE_TEXT_CHARS,
  SITE_PAGE_TITLE_CHARS,
  SITE_PAGES_MAX,
} from "../domain/research/constants.ts";

export const RESEARCH_JUDGE_COMPANY = "signals.research-judge-company";

export const researchJudgeInput = z.strictObject({
  company: z.strictObject({ name: z.string().max(300) }),
  source: z.strictObject({
    focus: z.string().max(INPUT_TEXT_MAX),
    region: z.string().max(INPUT_TEXT_MAX),
  }),
  /** The audience's lists: the must-haves and disqualifiers are numbered by their place, from 1. */
  audience: z.strictObject({
    mustHaves: z.array(z.string().max(CRITERION_CHARS)).max(CRITERIA_MAX),
    disqualifiers: z.array(z.string().max(CRITERION_CHARS)).max(CRITERIA_MAX),
    industries: z.array(z.string().max(INPUT_ITEM_MAX)).max(INPUT_ITEMS_MAX),
    sizeRanges: z.array(z.string().max(INPUT_ITEM_MAX)).max(INPUT_ITEMS_MAX),
    countries: z.array(z.string().max(INPUT_ITEM_MAX)).max(INPUT_ITEMS_MAX),
  }),
  /** What the page that named the company says of it, scrubbed; null for none. */
  named: z
    .strictObject({
      line: z.string().max(REASON_LINE_CHARS),
      quote: z.string().max(REASON_QUOTE_CHARS),
    })
    .nullable(),
  /** The company's own pages in the order read, numbered from 1 by their place. */
  site: z.strictObject({
    pages: z
      .array(
        z.strictObject({
          address: z.string().max(600),
          title: z.string().max(SITE_PAGE_TITLE_CHARS),
          text: z.string().max(SITE_PAGE_TEXT_CHARS),
        }),
      )
      .max(SITE_PAGES_MAX),
  }),
});
export type ResearchJudgeInput = z.output<typeof researchJudgeInput>;

/** The number of a page of the site, from 1. */
const pageNumber = z.int().min(1).max(SITE_PAGES_MAX);
/** One answer: its line and quote and the page of the quote, all null for `not_stated`. */
const answer = z.strictObject({
  answer: z.enum(ANSWERS),
  line: z.string().max(REASON_LINE_CHARS).nullable(),
  quote: z.string().max(REASON_QUOTE_CHARS).nullable(),
  page: pageNumber.nullable(),
});
/** The answer for the must-have or the disqualifier numbered `n`. */
const numbered = answer.extend({ n: z.int().min(1).max(CRITERIA_MAX) });
const word = z.strictObject({ value: z.string().max(PLACE_WORD_CHARS), page: pageNumber });

export const researchJudgeOutput = z.strictObject({
  focus: answer,
  mustHaves: z.array(numbered).max(CRITERIA_MAX),
  disqualifiers: z.array(numbered).max(CRITERIA_MAX),
  /** Whether the site shows the company in one of the audience's industries, and its size in one of the sizes. */
  industry: answer,
  size: answer,
  /** Where the site puts the company: the country as an ISO 3166-1 alpha-2 code, with the site's words for it. */
  country: z
    .strictObject({
      code: z.string().max(2),
      quote: z.string().max(PLACE_WORD_CHARS),
      page: pageNumber,
    })
    .nullable(),
  town: word.nullable(),
  state: word.nullable(),
  /** `shown`: the site says one person runs it; `contradicted`: it names a team; else `not_stated`. */
  onePerson: answer,
  /** How the site says the company can be reached: a general address, its phone lines, its postal address. */
  email: z
    .strictObject({
      address: z.string().max(EMAIL_CHARS),
      page: pageNumber,
      kind: z.enum(["general", "person"]),
    })
    .nullable(),
  phones: z
    .array(z.strictObject({ number: z.string().max(PHONE_CHARS), page: pageNumber }))
    .max(PHONES_MAX),
  postal: z.strictObject({ address: z.string().max(POSTAL_CHARS), page: pageNumber }).nullable(),
});
export type ResearchJudgeOutput = z.output<typeof researchJudgeOutput>;

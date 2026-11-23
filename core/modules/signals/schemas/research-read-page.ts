// The page-reading agent's input and output (agents/research-read-page/README.md; gamma-wr-046). The
// input, a field per data block: what the source looks for, what a page of this source type shows,
// and the page: its address, title, text (scrubbed of links, email addresses and phone numbers, and
// cut) and its links. The output: what the page is and the companies it names, each with its name, its
// link, its place and one line with the quote behind it. The gates that keep only what the page holds
// are in code (domain/research/read-checks.ts).
import { z } from "zod";
import {
  COMPANY_LINE_CHARS,
  COMPANY_NAME_CHARS,
  COMPANY_PLACE_CHARS,
  COMPANY_QUOTE_CHARS,
  INPUT_TEXT_MAX,
  PAGE_COMPANIES_MAX,
  PAGE_KINDS,
  PAGE_LINK_CHARS,
  PAGE_LINKS_MAX,
  PAGE_TEXT_INPUT_CHARS,
  PAGE_TITLE_INPUT_CHARS,
  PLACE_TEXT_MAX,
} from "../domain/research/constants.ts";

export const RESEARCH_READ_PAGE = "signals.research-read-page";

export const researchReadInput = z.strictObject({
  source: z.strictObject({
    focus: z.string().max(INPUT_TEXT_MAX),
    region: z.string().max(INPUT_TEXT_MAX),
  }),
  /** What a page of the search's source type shows; null for a start page, which has none. */
  place: z
    .strictObject({
      shows: z.string().max(PLACE_TEXT_MAX),
      pageKind: z.enum(PAGE_KINDS),
    })
    .nullable(),
  page: z.strictObject({
    address: z.string().max(PAGE_LINK_CHARS * 3),
    title: z.string().max(PAGE_TITLE_INPUT_CHARS),
    text: z.string().max(PAGE_TEXT_INPUT_CHARS),
    links: z.array(z.string().max(PAGE_LINK_CHARS)).max(PAGE_LINKS_MAX),
  }),
});
export type ResearchReadInput = z.output<typeof researchReadInput>;

/** What the page is: a company's own site, a list of companies, a notice that names some, or none of those. */
export const PAGE_IS = [...PAGE_KINDS, "other"] as const;

export const researchReadOutput = z.strictObject({
  is: z.enum(PAGE_IS),
  companies: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(COMPANY_NAME_CHARS),
        link: z.string().max(PAGE_LINK_CHARS).nullable(),
        place: z.string().max(COMPANY_PLACE_CHARS).nullable(),
        line: z.string().max(COMPANY_LINE_CHARS).nullable(),
        quote: z.string().max(COMPANY_QUOTE_CHARS).nullable(),
      }),
    )
    .max(PAGE_COMPANIES_MAX),
});
export type ResearchReadOutput = z.output<typeof researchReadOutput>;

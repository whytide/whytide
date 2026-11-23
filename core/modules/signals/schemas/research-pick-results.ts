// The result-picking agent's input and output (agents/research-pick-results/README.md; gamma-wr-045).
// The input, a field per data block: what the source looks for, the query one search answered, what
// the query's source type shows, and that search's results, each numbered with its address, title and
// snippet; never a name of the member's, an email address or a phone number (the free text goes
// through the rating's scrub). The output: the numbers of the results worth reading, the likeliest
// first. The gate that refuses a number the input lacks is in code (domain/research/checks.ts).
import { z } from "zod";
import {
  INPUT_TEXT_MAX,
  PAGE_KINDS,
  PICK_RESULTS_MAX,
  PLACE_TEXT_MAX,
  PLAN_QUERY_INPUT_CHARS,
  RESULT_SNIPPET_CHARS,
  RESULT_TITLE_CHARS,
  RESULT_URL_CHARS,
} from "../domain/research/constants.ts";

export const RESEARCH_PICK_RESULTS = "signals.research-pick-results";

const index = z.int().min(1).max(PICK_RESULTS_MAX);
const code = z.string().max(8);

export const researchPickInput = z.strictObject({
  source: z.strictObject({
    focus: z.string().max(INPUT_TEXT_MAX),
    region: z.string().max(INPUT_TEXT_MAX),
  }),
  query: z.strictObject({
    place: z.string().max(64),
    country: code,
    language: code,
    text: z.string().max(PLAN_QUERY_INPUT_CHARS),
  }),
  place: z.strictObject({
    shows: z.string().max(PLACE_TEXT_MAX),
    finding: z.string().max(PLACE_TEXT_MAX),
    pageKind: z.enum(PAGE_KINDS),
  }),
  results: z
    .array(
      z.strictObject({
        index,
        url: z.string().max(RESULT_URL_CHARS),
        title: z.string().max(RESULT_TITLE_CHARS),
        snippet: z.string().max(RESULT_SNIPPET_CHARS),
      }),
    )
    .min(1)
    .max(PICK_RESULTS_MAX),
});
export type ResearchPickInput = z.output<typeof researchPickInput>;

export const researchPickOutput = z.strictObject({
  picks: z.array(z.strictObject({ index })).max(PICK_RESULTS_MAX),
});
export type ResearchPickOutput = z.output<typeof researchPickOutput>;

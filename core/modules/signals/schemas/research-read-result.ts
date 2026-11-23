// The result-reading agent's input and output (agents/research-read-result/README.md; gamma-wr-090). The
// input, a field per data block: the company (its name) and the results of a search for its managers
// that code kept, each a number, a title and a snippet; never an address. The text is not scrubbed of
// names: the agent reads the name and the role a title and a snippet give, which is its whole job; it is
// extraction, and the pick that judges the people never sees any of it (research-pick-people). The
// output: for each result that names a person with a role, the number of the result and the name and
// the role as its title and snippet write them. The gates that keep only what the results hold are in
// code (domain/research/managers-checks.ts).
import { z } from "zod";
import {
  MANAGERS_RESULTS_MAX,
  PERSON_NAME_CHARS,
  PERSON_ROLE_CHARS,
} from "../domain/research/constants.ts";

export const RESEARCH_READ_RESULT = "signals.research-read-result";

export const researchReadResultInput = z.strictObject({
  company: z.strictObject({ name: z.string().max(300) }),
  results: z
    .array(
      z.strictObject({
        n: z.int().min(1).max(MANAGERS_RESULTS_MAX),
        title: z.string().max(600),
        snippet: z.string().max(1_500),
      }),
    )
    .min(1)
    .max(MANAGERS_RESULTS_MAX),
});
export type ResearchReadResultInput = z.output<typeof researchReadResultInput>;

export const researchReadResultOutput = z.strictObject({
  people: z
    .array(
      z.strictObject({
        result: z.int().min(1).max(MANAGERS_RESULTS_MAX),
        name: z.string().min(1).max(PERSON_NAME_CHARS),
        role: z.string().min(1).max(PERSON_ROLE_CHARS),
      }),
    )
    .max(MANAGERS_RESULTS_MAX),
});
export type ResearchReadResultOutput = z.output<typeof researchReadResultOutput>;

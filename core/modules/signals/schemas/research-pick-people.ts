// The people-picking agent's input and output (agents/research-pick-people/README.md; gamma-wr-060,
// rule 35: the AI never judges a person by name). The input holds the audience's titles and
// seniorities and, for each person a company's pages named, a number and the text of their role,
// scrubbed of links, email addresses, phone numbers and every name read: never a name, a link or an
// address. The output: the numbers of the people who fit, the best first. The gate that refuses a
// number the input lacks is in code (domain/research/people-checks.ts).
import { z } from "zod";
import {
  INPUT_ITEM_MAX,
  INPUT_ITEMS_MAX,
  PEOPLE_PICK_MAX,
  PICK_ROLE_CHARS,
} from "../domain/research/constants.ts";

export const RESEARCH_PICK_PEOPLE = "signals.research-pick-people";

const index = z.int().min(1).max(PEOPLE_PICK_MAX);

export const researchPickPeopleInput = z.strictObject({
  audience: z.strictObject({
    titles: z.array(z.string().max(INPUT_ITEM_MAX)).max(INPUT_ITEMS_MAX),
    seniorities: z.array(z.string().max(INPUT_ITEM_MAX)).max(INPUT_ITEMS_MAX),
  }),
  /** How many the run keeps at most: the answer may hold fewer, and never more is kept. */
  limit: z.int().min(1).max(PEOPLE_PICK_MAX),
  people: z
    .array(z.strictObject({ index, role: z.string().max(PICK_ROLE_CHARS) }))
    .min(1)
    .max(PEOPLE_PICK_MAX),
});
export type ResearchPickPeopleInput = z.output<typeof researchPickPeopleInput>;

export const researchPickPeopleOutput = z.strictObject({
  picks: z.array(z.strictObject({ index })).max(PEOPLE_PICK_MAX),
});
export type ResearchPickPeopleOutput = z.output<typeof researchPickPeopleOutput>;

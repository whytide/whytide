// The requests and answers of the ICP's routes (README "Routes"), from which the api host validates
// the input and builds the OpenAPI document. The lengths and counts are checked here (400
// validation_failed); a value of a closed list is any string here, so that one off the list answers
// its own code from domain/rules.ts.
import { z } from "zod";
import { COUNTRIES, CRITERION_KEYS, LIMITS, SENIORITIES, SIZE_RANGES } from "../domain/lists.ts";

const item = z.string().trim().min(1).max(LIMITS.item);
const text = z.string().trim().max(LIMITS.text);
const listValue = z.string().max(LIMITS.item);

export const icpBody = z.strictObject({
  name: z.string().trim().max(LIMITS.name),
  titles: z.array(item).max(LIMITS.titles),
  seniorities: z
    .array(listValue)
    .max(SENIORITIES.length)
    .describe(`Of ${SENIORITIES.join(", ")}; another value is icp_unknown_seniority`),
  industries: z.array(item).max(LIMITS.industries),
  sizeRanges: z
    .array(listValue)
    .max(SIZE_RANGES.length)
    .describe(`Of ${SIZE_RANGES.join(", ")}; another value is icp_unknown_size_range`),
  countries: z
    .array(listValue)
    .max(COUNTRIES.length)
    .describe("ISO 3166-1 alpha-2 codes; another value is icp_unknown_country"),
  mustHaves: text,
  disqualifiers: text,
});
export type IcpBody = z.infer<typeof icpBody>;

export const icpResponse = z.strictObject({
  id: z.string(),
  name: z.string(),
  titles: z.array(z.string()),
  seniorities: z.array(z.enum(SENIORITIES)),
  industries: z.array(z.string()),
  sizeRanges: z.array(z.enum(SIZE_RANGES)),
  countries: z.array(z.string()),
  mustHaves: z.string(),
  disqualifiers: z.string(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type IcpResponse = z.infer<typeof icpResponse>;

const criterion = z.strictObject({
  key: z.enum(CRITERION_KEYS),
  weight: z.number().int().min(0).max(100),
  isMust: z.boolean(),
  enabled: z.boolean(),
});

export const criteriaBody = z.strictObject({
  criteria: z
    .array(criterion)
    .length(CRITERION_KEYS.length)
    .refine((rows) => new Set(rows.map((row) => row.key)).size === rows.length, "each key once")
    .describe("The six criteria, each key once; the weights sum to 100 (icp_weights_must_sum_100)"),
});
export type CriteriaBody = z.infer<typeof criteriaBody>;

export const criteriaResponse = z.strictObject({ criteria: z.array(criterion) });
export type CriteriaResponse = z.infer<typeof criteriaResponse>;

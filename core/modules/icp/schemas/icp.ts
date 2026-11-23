// The requests and answers of the ICP's routes (README "Routes"), from which the api host validates
// the input and builds the OpenAPI document. The lengths and counts are checked here (400
// validation_failed); a value of a closed list is any string here, so that one off the list answers
// its own code from domain/rules.ts, and the brief any length, so that one over it answers its own.
// An audience's routes take the ICP's bodies and answer as the ICP's do (README "Routes").
import { z } from "zod";
import { AUDIENCE_NAME_MAX, AUDIENCES_PER_WORKSPACE, ID_MAX } from "../domain/constants.ts";
import {
  COUNTRIES,
  CRITERION_KEYS,
  DRAFT_STATUSES,
  LIMITS,
  SENIORITIES,
  SIZE_RANGES,
} from "../domain/lists.ts";

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

/** The audience a route's path names: one of the workspace's, else icp_not_found. */
export const audienceParams = z.strictObject({ icpId: z.string().min(1).max(ID_MAX) });

export const audienceBody = z.strictObject({
  name: z.string().trim().min(1).max(AUDIENCE_NAME_MAX),
});
export type AudienceBody = z.infer<typeof audienceBody>;

/** An audience as the list and the create answer it, without its fields. */
export const audienceResponse = z.strictObject({
  id: z.string(),
  name: z.string().describe("Empty for a default no one named, which the screen names itself"),
  isDefault: z.boolean().describe("The default: every route and caller without an icpId reads it"),
  createdBy: z
    .string()
    .nullable()
    .describe("The member whose request created it, `system` for the worker's; null before"),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type AudienceResponse = z.infer<typeof audienceResponse>;

export const audiencesResponse = z.strictObject({
  audiences: z.array(audienceResponse).describe("The default first, then by name"),
  limits: z
    .strictObject({
      audiences: z
        .number()
        .int()
        .describe(
          `The most audiences a workspace holds, the default included, ${AUDIENCES_PER_WORKSPACE.default} by default`,
        ),
    })
    .describe("The limit the server is configured with, which the screen shows"),
});
export type AudiencesResponse = z.infer<typeof audiencesResponse>;

/** The draft's routes' audience: without one, the default's draft, as before audiences. */
export const draftQuery = z.strictObject({
  icpId: z
    .string()
    .min(1)
    .max(ID_MAX)
    .optional()
    .describe("An audience's id: its draft; the default's without one"),
});
export type DraftQuery = z.infer<typeof draftQuery>;

export const draftBody = z.strictObject({
  brief: z
    .string()
    .optional()
    .describe(
      `What the admin sells to, data for the model; trimmed, over ${LIMITS.brief} characters is icp_draft_brief_too_long`,
    ),
});
export type DraftBody = z.infer<typeof draftBody>;

export const acceptDraftBody = z.strictObject({
  runId: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "The proposal's run, GET's pending.runId; another than the ICP's latest is icp_draft_none",
    ),
  replace: z
    .boolean()
    .optional()
    .describe("Also replace an ICP that has targeting; else icp_not_empty. False by default"),
});
export type AcceptDraftBody = z.infer<typeof acceptDraftBody>;

/** The latest draft, never its brief, its model or its decision record. */
export const draftResponse = z.strictObject({
  status: z.enum(DRAFT_STATUSES),
  error: z
    .string()
    .nullable()
    .describe("The failed draft's code: ai_failed, draft_failed or icp_draft_no_source"),
  pending: z
    .strictObject({
      fields: icpResponse.omit({ id: true, version: true, updatedAt: true }),
      promptVersion: z.number().int(),
      runId: z.string().describe("The run that drafted it, which the accept sends back"),
    })
    .nullable()
    .describe("The drafted proposal until it is used or discarded, or a new draft starts"),
  hasKnowledge: z.boolean().describe("Company Knowledge has a content field to draft from"),
});
export type DraftResponse = z.infer<typeof draftResponse>;

// The request and answer of the Company Knowledge routes (README "Routes"), from which the api host
// validates the input and builds the OpenAPI document. The lengths and counts are checked here (400
// validation_failed, `details.fields`); a URL is any string here, so that one that is not http or
// https answers its own code from domain/rules.ts.
import { z } from "zod";
import { FETCH_STATUSES, LIMITS } from "../domain/fields.ts";
import { pendingDraft } from "./draft-company-knowledge.ts";

const text = (max: number) => z.string().trim().max(max);
const list = z.array(z.string().trim().min(1).max(LIMITS.item)).max(LIMITS.items);
const url = z.string().trim().max(LIMITS.url);

export const companyKnowledgeBody = z.strictObject({
  sourceUrl: url
    .nullable()
    .describe(
      "The website, http or https, empty or null for none; else company_knowledge_invalid_url",
    ),
  oneLiner: text(LIMITS.oneLiner),
  longDescription: text(LIMITS.longDescription),
  products: list,
  painPoints: list,
  featuresBenefits: list,
  proofPoints: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(LIMITS.proofPoint),
        sourceUrl: url
          .optional()
          .describe("The page it comes from, http or https, or a document's document:<name>"),
      }),
    )
    .max(LIMITS.items),
  competitors: list,
  tone: text(LIMITS.tone),
});
export type CompanyKnowledgeBody = z.infer<typeof companyKnowledgeBody>;

export const acceptDraftBody = z.strictObject({
  replaceEdited: z
    .boolean()
    .optional()
    .describe("Also replace what a person wrote; false by default"),
});
export type AcceptDraftBody = z.infer<typeof acceptDraftBody>;

const fieldSource = z.strictObject({
  kind: z.enum(["ai_draft", "human"]),
  at: z.iso.datetime(),
  sourceUrl: z.string().optional(),
});
/** Who wrote each content field last (CONTENT_FIELDS); a field nobody wrote has none. */
const fieldSources = z
  .strictObject({
    oneLiner: fieldSource,
    longDescription: fieldSource,
    products: fieldSource,
    painPoints: fieldSource,
    featuresBenefits: fieldSource,
    proofPoints: fieldSource,
    competitors: fieldSource,
    tone: fieldSource,
  })
  .partial();

/** A page the last website fetch read (README "The website fetch"), in the order it read them. */
const websitePage = z.strictObject({
  url: z.string(),
  title: z.string(),
  status: z
    .enum(["fetched", "truncated"])
    .describe("truncated: cut at one megabyte or 50,000 characters"),
  fetchedAt: z.iso.datetime(),
});

export const companyKnowledgeResponse = z.strictObject({
  id: z.string(),
  sourceUrl: z.string().nullable(),
  fetchStatus: z.enum(FETCH_STATUSES),
  fetchedAt: z.iso.datetime().nullable(),
  fetchError: z
    .string()
    .nullable()
    .describe("The code of the last failed run: egress_*, fetch_failed, ai_failed or draft_failed"),
  oneLiner: z.string(),
  longDescription: z.string(),
  products: z.array(z.string()),
  painPoints: z.array(z.string()),
  featuresBenefits: z.array(z.string()),
  proofPoints: z.array(z.strictObject({ text: z.string(), sourceUrl: z.string().optional() })),
  competitors: z.array(z.string()),
  tone: z.string(),
  fieldSources,
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
  pendingDraft: pendingDraft.nullable().describe("The drafter's draft until accepted or discarded"),
  pages: z.array(websitePage),
});
export type CompanyKnowledgeResponse = z.infer<typeof companyKnowledgeResponse>;

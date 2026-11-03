// The rules of contacts' inputs (docs/concepts.md): what a source may bring of a person or a
// company, each field within the LinkedIn port's limits, a hash record, and a lead's source,
// qualification and list. The commands parse their input with these; an error names the fields at
// fault, never a value.
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../errors.ts";
import { SOURCE_LABEL_MAX, SOURCE_URL_MAX } from "./constants.ts";
import { CONFIDENCES, LEAD_SORTS, QUALIFICATION_STATUSES, SOURCE_KINDS, TIERS } from "./lead.ts";
import { OUTREACH_STATUSES } from "./outreach/constants.ts";
import { PROVIDERS, SOURCES } from "./provenance.ts";
import { REVIEW_FILTERS } from "./review/rules.ts";

const text = (max: number) => z.string().trim().max(max).optional();
export const id = z.string().min(1).max(64);
const source = z.enum(SOURCES);
const provider = z.enum(PROVIDERS).nullable();
const providerId = z.string().trim().min(1).max(256).optional();
/** An aggregate code (`hard_filter`, `title_mismatch`), never a value about the person. */
export const code = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** provider_refs is keyed by the provider: an id needs one. */
const keyed = (input: { provider: unknown; [key: string]: unknown }, value: unknown) =>
  value === undefined || input.provider !== null;

export const upsertPersonInput = z
  .strictObject({
    source,
    provider,
    profile: z.strictObject({
      linkedinUrl: z.string(),
      providerId,
      /** A full name, split into the first and the last when neither is given (provenance.ts). */
      name: text(200),
      firstName: text(100),
      lastName: text(100),
      headline: text(300),
      title: text(300),
      companyName: text(300),
      locationText: text(300),
      fetchedAt: z.date().optional(),
    }),
  })
  .refine((input) => keyed(input, input.profile.providerId), { path: ["profile", "providerId"] });

export const upsertCompanyInput = z
  .strictObject({
    source,
    provider,
    company: z.strictObject({
      name: z.string().trim().min(1).max(300),
      domain: text(253),
      linkedinUrl: z.string().optional(),
      industry: text(200),
      sizeRange: text(50),
      /** A code or a name (countries.ts). */
      country: text(100),
      providerId,
      fetchedAt: z.date().optional(),
    }),
  })
  .refine((input) => keyed(input, input.company.providerId), { path: ["company", "providerId"] });

export const linkInput = z.strictObject({ personId: id, companyId: id });
export const listInput = z.strictObject({ limit: z.int().min(1).max(100), cursor: id.optional() });
export const recordHashInput = z
  .strictObject({
    linkedinUrl: z.string().optional(),
    providerId: z.string().optional(),
    kind: z.enum(["rejected_candidate", "erased"]),
    dropReasons: z.array(code).max(10).default([]),
  })
  .refine((input) => (input.linkedinUrl === undefined) !== (input.providerId === undefined), {
    path: ["linkedinUrl"],
  });

export const createLeadInput = z.strictObject({
  personId: id,
  source: z.strictObject({
    kind: z.enum(SOURCE_KINDS),
    ref: id,
    at: z.date().optional(),
    /** The source's name as its module shows it: a signal source's label. */
    label: z.string().trim().min(1).max(SOURCE_LABEL_MAX).optional(),
    /** An https URL that parses, whatever its host: a signal source's post. */
    url: z
      .string()
      .max(SOURCE_URL_MAX)
      .refine((value) => URL.parse(value)?.protocol === "https:")
      .optional(),
  }),
});
/** A why bullet: a message key (the i18n runtime's shape) and its values, each 300 long at most. */
const whyBullet = z.strictObject({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9_]*)+$/)
    .max(120),
  params: z
    .record(z.string().regex(/^[a-zA-Z]\w{0,39}$/), z.union([z.string().max(300), z.number()]))
    .refine((params) => Object.keys(params).length <= 10)
    .optional(),
});
export const applyQualificationInput = z.strictObject({
  personId: id,
  status: z.enum(QUALIFICATION_STATUSES),
  fitScore: z.int().min(0).max(100).optional(),
  confidence: z.enum(CONFIDENCES).optional(),
  tier: z.enum(TIERS).optional(),
  why: z.array(whyBullet).max(3).optional(),
  snapshotId: id.optional(),
  icpVersion: z.int().min(1).optional(),
  /** hard_filter_reason when the status is hard_filtered, status_reason otherwise. */
  reason: code.optional(),
});
export const leadListInput = z.strictObject({
  status: z.enum(QUALIFICATION_STATUSES).optional(),
  tier: z.enum(TIERS).optional(),
  review: z.enum(REVIEW_FILTERS).optional(),
  outreach: z.enum(OUTREACH_STATUSES).optional(),
  sort: z.enum(LEAD_SORTS),
  limit: z.int().min(1).max(100),
  cursor: z.string().min(1).max(200).optional(),
});
export const pendingInput = z.strictObject({
  limit: z.int().min(1).max(500),
  icpVersion: z.int().min(1).optional(),
});
export const neighboursInput = z.strictObject({
  personId: id,
  status: z.enum(QUALIFICATION_STATUSES).optional(),
  tier: z.enum(TIERS).optional(),
  review: z.enum(REVIEW_FILTERS).optional(),
  outreach: z.enum(OUTREACH_STATUSES).optional(),
  sort: z.enum(LEAD_SORTS),
});

/** An id argument, a non-empty string, or contacts_input_invalid naming `field`. */
export function requireId(field: string, value: unknown): string {
  if (typeof value === "string" && value.length > 0 && value.length <= 64) return value;
  throw new AppError(errors.contacts_input_invalid, { details: { fields: [field] } });
}

/** The input as the schema reads it, or contacts_input_invalid naming the fields at fault, no value. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.map(String).join(".")))];
  throw new AppError(errors.contacts_input_invalid, { details: { fields } });
}

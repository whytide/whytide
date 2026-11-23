// The rules of contacts' inputs (docs/concepts.md): what a source may bring of a person or a
// company, each field within the LinkedIn port's limits, a hash record, a lead's source,
// qualification and list, and enrichment's hold and country. The commands parse their input with
// these; an error names the fields at fault, never a value.
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../errors.ts";
import {
  COMPANY_DESCRIPTION_MAX,
  COUNTRIES,
  EMPLOYEE_COUNT_MAX,
  HELD_LEADS_MAX,
  NAME_MATCH_MAX,
  PENDING_REASONS_MAX,
  PENDING_SNAPSHOTS_MAX,
  PENDING_SOURCES_MAX,
  PERSON_FIELD_MAX,
  SOURCE_LABEL_MAX,
  SOURCE_REF,
  SOURCE_URL_MAX,
} from "./constants.ts";
import { CONFIDENCES, LEAD_SORTS, QUALIFICATION_STATUSES, SOURCE_KINDS, TIERS } from "./lead.ts";
import { OUTREACH_STATUSES } from "./outreach/constants.ts";
import { PROVIDER_NAME, PROVIDER_NAME_MAX, SOURCES } from "./provenance.ts";
import { REVIEW_FILTERS } from "./review/rules.ts";

const text = (max: number) => z.string().trim().max(max).optional();
export const id = z.string().min(1).max(64);
const source = z.enum(SOURCES);
/** Any adapter's or source's name (provenance.ts), or null. */
const provider = z.string().max(PROVIDER_NAME_MAX).regex(PROVIDER_NAME).nullable();
const providerId = z.string().trim().min(1).max(256).optional();
/** An aggregate code (`hard_filter`, `title_mismatch`), never a value about the person. */
export const code = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** provider_refs is keyed by the provider: an id needs one. */
const keyed = (input: { provider: unknown; [key: string]: unknown }, value: unknown) =>
  value === undefined || input.provider !== null;

/**
 * What a source brings of a person: a LinkedIn profile URL, an email address, or both, never neither
 * (gamma-rf-050; contacts_input_invalid naming both), and the profile's fields. The address is kept as
 * its hash only (emails.ts); the batch takes a URL and no address (batch.ts).
 */
export const upsertPersonInput = z
  .strictObject({
    source,
    provider,
    profile: z.strictObject({
      linkedinUrl: z.string().optional(),
      email: z.string().optional(),
      providerId,
      /** A full name, split into the first and the last when neither is given (provenance.ts). */
      name: text(200),
      firstName: text(PERSON_FIELD_MAX.firstName),
      lastName: text(PERSON_FIELD_MAX.lastName),
      headline: text(PERSON_FIELD_MAX.headline),
      title: text(PERSON_FIELD_MAX.title),
      companyName: text(PERSON_FIELD_MAX.companyName),
      locationText: text(PERSON_FIELD_MAX.locationText),
      fetchedAt: z.date().optional(),
    }),
  })
  .refine((input) => keyed(input, input.profile.providerId), { path: ["profile", "providerId"] })
  .superRefine(({ profile }, context) => {
    if (profile.linkedinUrl !== undefined || profile.email !== undefined) return;
    for (const field of ["linkedinUrl", "email"]) {
      context.addIssue({ code: "custom", message: field, path: ["profile", field] });
    }
  });

/**
 * A member's edit of a person's profile fields (person-edit.ts): any of the six, each trimmed and
 * within its source's limit; an empty one clears the field, but the first name, which stays.
 */
export const editPersonInput = z.strictObject({
  firstName: z.string().trim().min(1).max(PERSON_FIELD_MAX.firstName).optional(),
  lastName: text(PERSON_FIELD_MAX.lastName),
  headline: text(PERSON_FIELD_MAX.headline),
  title: text(PERSON_FIELD_MAX.title),
  companyName: text(PERSON_FIELD_MAX.companyName),
  locationText: text(PERSON_FIELD_MAX.locationText),
});

/**
 * A member's lead by hand (lead-create.ts): the LinkedIn profile URL, which the command normalizes,
 * and the six fields by the edit's rules, the first name required; an empty optional one is none.
 */
export const memberLeadInput = editPersonInput.extend({
  linkedinUrl: z.string(),
  firstName: z.string().trim().min(1).max(PERSON_FIELD_MAX.firstName),
});

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
      /** The headcount a source gives (gamma-en-040). */
      employeeCount: z.int().min(1).max(EMPLOYEE_COUNT_MAX).optional(),
      description: text(COMPANY_DESCRIPTION_MAX),
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
  /** The audience the decision was judged against: icp's id, a plain id checked for nothing else. */
  icpId: id.optional(),
  icpVersion: z.int().min(1).optional(),
  /** hard_filter_reason when the status is hard_filtered, status_reason otherwise. */
  reason: code.optional(),
});
/** The list's `source`: the leads with a source of this `ref`, whatever its kind. */
const sourceRef = z.string().regex(SOURCE_REF);
export const leadListInput = z.strictObject({
  source: sourceRef.optional(),
  status: z.enum(QUALIFICATION_STATUSES).optional(),
  tier: z.enum(TIERS).optional(),
  review: z.enum(REVIEW_FILTERS).optional(),
  outreach: z.enum(OUTREACH_STATUSES).optional(),
  sort: z.enum(LEAD_SORTS),
  limit: z.int().min(1).max(100),
  cursor: z.string().min(1).max(200).optional(),
});
export const countsInput = z.strictObject({ source: sourceRef.optional() });
/**
 * The batch's read: `icpId`, an audience, comes with its `icpVersion`, and `isDefault`, that the
 * audience is the default one, with its `icpId`; else contacts_input_invalid naming the one missing.
 */
/** Leads by their first signal source's ref: among `in`, or with none or one outside `notIn`. */
const sourceFilter = z.union([
  z.strictObject({ in: z.array(id).max(PENDING_SOURCES_MAX) }),
  z.strictObject({ notIn: z.array(id).max(PENDING_SOURCES_MAX) }),
]);
export type SourceFilter = z.output<typeof sourceFilter>;
export const pendingInput = z
  .strictObject({
    limit: z.int().min(1).max(500),
    icpId: id.optional(),
    icpVersion: z.int().min(1).optional(),
    isDefault: z.boolean().optional(),
    hardFilterReasons: z.array(code).max(PENDING_REASONS_MAX).optional(),
    currentSnapshotIds: z.array(id).max(PENDING_SNAPSHOTS_MAX).optional(),
    pendingSources: sourceFilter.optional(),
    decidedSources: sourceFilter.optional(),
  })
  .refine((input) => input.icpId === undefined || input.icpVersion !== undefined, {
    path: ["icpVersion"],
  })
  .refine((input) => input.isDefault === undefined || input.icpId !== undefined, {
    path: ["icpId"],
  });
export const neighboursInput = z.strictObject({
  personId: id,
  source: sourceRef.optional(),
  status: z.enum(QUALIFICATION_STATUSES).optional(),
  tier: z.enum(TIERS).optional(),
  review: z.enum(REVIEW_FILTERS).optional(),
  outreach: z.enum(OUTREACH_STATUSES).optional(),
  sort: z.enum(LEAD_SORTS),
});

/** enrichment's read of the held leads (hold.ts): at most HELD_LEADS_MAX. */
export const heldInput = z.strictObject({ limit: z.int().min(1).max(HELD_LEADS_MAX) });
/** The leads whose hold ends (hold.ts): their person ids, HELD_LEADS_MAX at most. */
export const releaseInput = z.array(id).max(HELD_LEADS_MAX);
/**
 * A source's country for a person (person-country.ts): one of icp's COUNTRIES, as its code, with the
 * source's stamp; `at`, when the source read it, is now when absent.
 */
export const recordCountryInput = z.strictObject({
  personId: id,
  country: z.string().refine((code) => COUNTRIES.includes(code)),
  stamp: z.strictObject({ source, provider, at: z.date().optional() }),
});

/**
 * The match of a company's persons by name (person-match.ts): the company by its id or its name, and the
 * name in one text. A name or a company that is blank, or no company at all, is refused.
 */
export const matchByNameInput = z
  .strictObject({
    name: z.string().trim().min(1).max(NAME_MATCH_MAX),
    companyId: z.string().min(1).max(64).nullish(),
    companyName: z.string().trim().min(1).max(PERSON_FIELD_MAX.companyName).nullish(),
  })
  .refine(({ companyId, companyName }) => companyId != null || companyName != null, {
    path: ["companyId"],
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

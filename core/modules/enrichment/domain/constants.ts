// enrichment's names and bounds (README "How it works", docs/concepts.md). Pure: the workflows'
// sandbox imports it through plan.ts.

/** The source that expands into one per adapter of PROVIDER_COMPANY_DATA, `company-data/<adapter>`. */
export const COMPANY_DATA = "company-data";

/**
 * A company's fields a run looks for while they are empty, and its facts once old (FACT_FIELDS), as
 * contacts' WorkspaceCompany names them.
 */
export const COMPANY_FIELDS = [
  "domain",
  "linkedinUrl",
  "industry",
  "sizeRange",
  "country",
  "description",
] as const;
export type CompanyField = (typeof COMPANY_FIELDS)[number];
/** A person's fields, named `person.<field>` in a run's lists: the country (gamma-en-075). */
export const PERSON_FIELDS = ["person.country"] as const;
export type PersonField = (typeof PERSON_FIELDS)[number];
export type Field = CompanyField | PersonField;

/** contacts' class of a member's own value: a field a member set or cleared is never wanted. */
export const MEMBER_SOURCE = "member";

/** What a source needs, any one of them: the company's keys or name, the person's location text. */
export const INPUTS = ["linkedinUrl", "domain", "name", "locationText"] as const;
export type Input = (typeof INPUTS)[number];
/** The fields that are inputs too: a source that fills one adds an input to the run. */
export const KEY_FIELDS: readonly Field[] = ["linkedinUrl", "domain"];
/**
 * The company's facts a run asks for again once their stamp is older than ENRICHMENT_FACT_DAYS
 * (gamma-rf-020); the keys are asked for only while empty.
 */
export const FACT_FIELDS: readonly CompanyField[] = [
  "industry",
  "sizeRange",
  "country",
  "description",
];

/**
 * What asking a source came to, recorded in the run's sources_tried: `found`, `not_found`,
 * `no_company_key`, `allowance_spent`, `failed`, or a source's own word for a skip (`no_account`,
 * `ambiguous`), a code (CODE).
 */
export type Outcome = string;
export const NOT_FOUND: Outcome = "not_found";
/** The outcomes the step alone records: a source answers facts for one and throws for the other. */
export const STEP_OUTCOMES: readonly Outcome[] = ["found", "failed"];
/** The outcomes of a call the source answered: a run with one of them tried its company. */
export const ANSWERED: readonly Outcome[] = [
  "found",
  NOT_FOUND,
  "no_company_key",
  // web-search's: the same name answers the same until the retry days pass.
  "not_a_company",
  "ambiguous",
];

/** Why a run did not ask for the company (docs/flows.md "The run"). */
export const SKIP_REASONS = ["no_company", "enriched_recently", "company_running"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** A run `running` for longer no longer holds its company (docs/runbook.md "A run left running"). */
export const RUN_STALE_MINUTES = 60;
/** The company's runs within the retry days the prepare step reads, newest first. */
export const RECENT_RUNS = 20;
/** A `provider` source's start-to-close timeout; an `ai` source sets its own. */
export const PROVIDER_TIMEOUT_SECONDS = 15;
/** A `db` source's start-to-close timeout. */
export const DB_TIMEOUT_SECONDS = 60;

/** An error's code as a run keeps it; any other text is ACTIVITY_FAILED. */
export const CODE = /^[a-z][a-z0-9_]{0,63}$/;
export const ACTIVITY_FAILED = "activity_failed";
/** The code a list's name has when no source defines it (README "A name that cannot run"). */
export const SOURCE_UNKNOWN = "source_unknown";

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** The label a website's host is kept without as a domain (the `linkedin` source, gamma-en-060). */
export const WWW = "www.";
/** The country-ai source's name, its list's word and its provenance's provider (gamma-en-075). */
export const COUNTRY_AI = "country-ai";
/** The location text the country namer gets, at most, in characters. */
export const LOCATION_MAX = 200;
/** A country's code as the country namer answers it: two capital letters. */
export const COUNTRY_CODE = /^[A-Z]{2}$/;
/** The subject of the country namer's decision records: the cleaned location's sha256. */
export const LOCATION_SUBJECT = "location:";
/** An `ai` source's start-to-close timeout: the model's call and its one retry. */
export const AI_TIMEOUT_SECONDS = 60;
/**
 * country-ai's own words for an answer it does not write: a location naming no place (no call), a
 * call ended ai_failed, an answer not sure, or a code contacts does not know.
 */
export const COUNTRY_AI_OUTCOMES = {
  noPlace: "no_place",
  aiFailed: "ai_failed",
  notSure: "not_sure",
  unknownCountry: "unknown_country",
} as const;

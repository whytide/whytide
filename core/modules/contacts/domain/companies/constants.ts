// The company index's constants (gamma-rf-010; README.md "Shared companies"): which source classes
// may be shared between organizations, the facts and the keys a layer holds, the one-person rule's
// reading of a size, the locks' names and the link script's batch.

/**
 * The classes CONTACTS_SHARED_FACT_SOURCES may name: a fact they bring is about the company, read
 * from a public or licensed source, never a customer's own value. linkedin (read through a member's
 * account), import (a customer's file), member (typed by a member) and ai_inferred never are; the
 * migration's CHECK on companies.field_provenance holds the same list.
 */
export const SHAREABLE_CLASSES = ["open_data", "website", "web_search", "data_vendor"] as const;
export type ShareableClass = (typeof SHAREABLE_CLASSES)[number];

/** CONTACTS_SHARED_FACT_SOURCES unset: open data and the company's own website. */
export const SHARED_CLASSES_DEFAULT: readonly ShareableClass[] = ["open_data", "website"];

/** A company's facts, which the shared company and the group's row hold beside its keys. */
export const COMPANY_FACTS = [
  "industry",
  "sizeRange",
  "country",
  "employeeCount",
  "description",
] as const;
export type CompanyFact = (typeof COMPANY_FACTS)[number];

/** A company's keys, the LinkedIn page first: a row links by its page, else by its domain. */
export const COMPANY_KEYS = ["linkedinUrl", "domain"] as const;
export type CompanyKey = (typeof COMPANY_KEYS)[number];

/** The column of each key, for the raw SQL of store.ts. */
export const KEY_COLUMNS: Readonly<Record<CompanyKey, string>> = {
  linkedinUrl: "linkedin_url",
  domain: "domain",
};

/** The vendors' ids of a company, a layer's field beside the facts. */
export const PROVIDER_REFS = "providerRefs" as const;

/**
 * A size's bounds as text (`1`, `0-1`, `1-10`, `10,001+`, `2–10 employees`): the first number, then
 * an optional second after a dash, or a `+` for none above.
 */
export const SIZE_BOUNDS = /^\s*(\d[\d,]*)\s*(?:[-–]\s*(\d[\d,]*)|(\+))?/;

/** The headcount of a one-person company: its facts stay with the group (layers.ts). */
export const ONE_PERSON = 1;

/**
 * The advisory lock of a key's value in companies (store.ts), taken by the link before it looks the
 * key up or makes a company with it, and tried by an offer of the key, so two runs never give one
 * value to two companies.
 */
export const KEY_LOCK = "contacts.company_key";

/** The workspace rows one batch of `pnpm -F contacts companies:link` reads (link-all.ts). */
export const LINK_BATCH = 500;

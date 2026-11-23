// The email lookup's names and bounds (README "Email lookups", docs/flows.md "The lookup"). Pure:
// the workflow's sandbox imports it through outcome.ts.

/** The email source that expands into one per adapter of PROVIDER_EMAIL_FINDER, `email-finder/<adapter>`. */
export const EMAIL_FINDER = "email-finder";
/** A verifier's counter and its name in providers_tried: `email-verifier/<adapter>`. */
export const EMAIL_VERIFIER = "email-verifier";

/**
 * ENRICHMENT_EMAIL_VALID_DAYS's default (settings.ts, README "Settings"): the days a verified address
 * is trusted without a lookup (RB-7.3.3, F06 §7).
 */
export const EMAIL_VALID_DAYS = { default: 120 } as const;
/**
 * ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS's default (settings.ts, README "Settings"): the days a lookup
 * that found nothing usable is not asked again.
 */
export const NOT_FOUND_RETRY_DAYS = { default: 30 } as const;
/** Days a company domain found catch-all is not looked up, for every workspace. */
export const CATCH_ALL_STATUS_DAYS = 30;
/** One verified address is one unit of `enrichment.work_email`. */
export const LOOKUP_QUANTITY = 1;
/** The contact point's class for a finder's address; gamma-en-085 adds its own. */
export const FINDER_SOURCE_CLASS = "email_finder";
/** One basis until counsel names one per source (F19). */
export const LEGAL_BASIS = "legitimate_interest";
/** The credits' reservation of a lookup's attempt: `enr:<requestId>:<attempt>`. */
export const RESERVATION_PREFIX = "enr";
/** A candidate's file: `raw/enrichment/<requestId>/<n>.json`, 72 hours at most. */
export const RAW_FOLDER = "raw/enrichment";
export const RAW_CONTENT_TYPE = "application/json";
/** A candidate's file at most, in bytes. */
export const RAW_MAX_BYTES = 4096;

/**
 * The kinds of contact point that are an address. Every reader of an address names them (gamma-wr-100):
 * a phone sits in the same table and is never answered as one. A work address at the company's domain,
 * else a personal one.
 */
export const EMAIL_KINDS = ["work_email", "personal_email"] as const;
export const CONTACT_KINDS = EMAIL_KINDS;
export type ContactKind = (typeof EMAIL_KINDS)[number];
/** The verifiers' five verdicts (the email-verifier port's), never folded. */
export const VERDICTS = ["valid", "catch_all", "risky", "invalid", "unknown"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Why a lookup ended without an address, one message each on the Email panel. */
export const MISSING_REASONS = [
  "suppressed",
  "no_name",
  "no_domain",
  "catch_all",
  "not_verified",
  "no_result",
  "other_domain",
  "held_by_other_person",
  "cached_negative",
  "insufficient_credits",
  "provider_error",
  "no_address",
  "no_verifier_left",
  "personal_needs_consent",
  "bounced",
] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];

/**
 * The ends the prepare turns into a lookup of the lead's own sources (gamma-en-100): those with
 * `anyDomain`, in the list's order, nothing reserved. The reason is kept on the running request; with
 * nothing kept, the settle ends the lookup with it, as before: `insufficient_credits` as
 * `waiting_budget`, the others as `not_found`.
 */
export const OWN_SOURCES_REASONS = [
  "no_domain",
  "catch_all",
  "insufficient_credits",
] as const satisfies readonly MissingReason[];
export type OwnSourcesReason = (typeof OWN_SOURCES_REASONS)[number];

/**
 * What dropped a candidate before any verifier, recorded as its `candidate` step's outcome: off the
 * address's form, off the company's domain, at a company domain recorded catch-all (a lookup of the
 * lead's own sources, gamma-en-100), seen already, judged invalid by its own finder, or a personal
 * address waiting for consent.
 */
export const DROPS = [
  "address_invalid",
  "other_domain",
  "catch_all_domain",
  "seen",
  "vendor_invalid",
  "personal_needs_consent",
] as const;
export type Drop = (typeof DROPS)[number];
/** A candidate kept for a verifier. */
export const KEPT = "kept";

/** The steps of providers_tried: a source asked, one of its candidates, a verifier's turn. */
export type LookupStepName = "find" | "candidate" | "verify";
/** What a step came to: a verdict, a drop, `kept`, `found`, `not_found`, `allowance_spent`, `failed`. */
export type TriedEntry = {
  readonly source: string;
  readonly step: LookupStepName;
  readonly outcome: string;
  readonly code: string | null;
  readonly ms: number;
};

/** The persons' countries where a cold email to a personal address needs consent: privacy's list. */
const EU = "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK";
const EU_REGIONS = "AX GF GP MF MQ RE YT";
const EEA = "IS LI NO";
const UK = "GB";
/**
 * privacy's RETENTION_EU_UK_COUNTRIES (its domain/retention/constants.ts), copied, as privacy
 * imports this module and no module imports privacy; tests/key.test.ts asserts the same 37 codes as
 * privacy's tests/retention.test.ts.
 */
export const CONSENT_COUNTRIES: ReadonlySet<string> = new Set(
  [EU, EU_REGIONS, EEA, UK].join(" ").split(" "),
);
/** A country as contacts writes one; anything else is no known country. */
export const COUNTRY_CODE = /^[A-Z]{2}$/;

/**
 * The email source of LinkedIn's "Contact info" (gamma-en-087, ../sources/linkedin-contact-info.ts):
 * its name in ENRICHMENT_EMAIL_SOURCES, its contact points' class, the provider its definition names
 * (the adapter that read stands in when PROVIDER_LINKEDIN names one), and its outcome while
 * LINKEDIN_CONTACT_INFO_ENABLED is off.
 */
export const CONTACT_INFO_SOURCE = Object.freeze({
  name: "linkedin-contact-info",
  sourceClass: "linkedin_contact_info",
  provider: "unipile",
  disabled: "disabled",
} as const);

/**
 * The lookup at find (gamma-wr-070): the address a page printed with a person is verified first, by a
 * step of the lookup's own named `printed`; its contact point's class and provider name the page.
 * An address is 254 characters at most.
 */
export const PRINTED = Object.freeze({
  name: "printed",
  sourceClass: "page_printed",
  provider: "page",
} as const);
export const PRINTED_ADDRESS_MAX = 254;

/** The contact points one batch of `pnpm -F enrichment emails:record` reads (gamma-rf-040). */
export const RECORD_BATCH = 500;

/**
 * The lookup for a name that is not a person yet (gamma-wr-080). The credit's reservation is
 * `enr:name:<key>:<attempt>`: `key` is the caller's (the found company's id and the person's place
 * in the pick: an id and a number, so a name does not fit; the id is the credit's subject) and
 * `attempt` a part of each call. `notMade` ends a caller that made no person for the address.
 */
export const NAME_LOOKUP = Object.freeze({
  reservationPrefix: `${RESERVATION_PREFIX}:name`,
  key: /^([a-z][a-z0-9_]*_[0-9A-Za-z]{1,64}):[1-9][0-9]{0,5}$/,
  notMade: "not_made",
} as const);

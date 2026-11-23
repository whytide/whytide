// The never-contact list's words and limits (docs/concepts.md "Suppression entry"), beside the code
// that reads them: entries.ts, matching.ts, checks.ts, and the routes' schemas.

/**
 * CONTACTS_RECENT_TOUCH_DAYS's default (settings.ts, README.md "Settings"): a new enrollment is refused
 * while the person's last outbound touch is younger than this many days.
 */
export const RECENT_TOUCH_DAYS = { default: 90 } as const;

/** A day, in milliseconds. */
export const DAY_MS = 86_400_000;

/** A domain entry, and each parent domain a company matches by, has at least this many labels. */
export const MIN_DOMAIN_LABELS = 2;

/**
 * The workspace's blocks, the person's own opt-outs, which are never removed, and the companies
 * excluded by their domain as customers or competitors (gamma-p2-040).
 */
export const SUPPRESSION_LAYERS = ["blocklist", "opt_out", "relationship"] as const;

/** The layers an add names; a relationship entry comes from its relationship instead. */
export const ADD_LAYERS = ["blocklist", "opt_out"] as const;

/** The layers whose entry can be lifted (suppression.remove); an opt-out never is. */
export const REMOVABLE_LAYERS = ["blocklist", "relationship"] as const;

/** What a company is excluded as, by its domain: a relationship entry's kind. */
export const SUPPRESSION_RELATIONSHIPS = ["customer", "competitor"] as const;

/**
 * What an entry's hash is of: a profile or company page URL, a company's domain, or a person's email
 * address (gamma-rf-040).
 */
export const SUPPRESSION_MATCH_TYPES = ["linkedin_url", "domain", "email"] as const;

/**
 * The channels an entry stops: every one, or LinkedIn or email alone. An opt-out is always `all`
 * (the CHECK suppression_entries_opt_out_every_channel).
 */
export const SUPPRESSION_CHANNELS = ["all", "linkedin", "email"] as const;

/** The channel an entry stops when the add names none, and an opt-out's always. */
export const EVERY_CHANNEL = "all";

/**
 * The channel an email address is for: an entry on it, or on every channel, that holds an address
 * keeps enrichment from keeping it (emails.ts recordPersonEmail, gamma-rf-040).
 */
export const EMAIL_CHANNEL = "email" satisfies SuppressionChannel;

/** The most persons one suppressionsOf call answers (not in the sources). */
export const SUPPRESSION_BATCH_SIZE = 500;

/** The roles that may lift an exclusion (permissions.ts suppression.remove; the screen's Remove). */
export const SUPPRESSION_REMOVE_ROLES = ["Owner", "Admin"] as const;

/**
 * Who added an entry: a user by hand, the system (an opt-out found in a reply), or a user's exclusion
 * list from a CSV (gamma-p2-045), the entry then with its list (the CHECK suppression_entries_csv_list).
 */
export const SUPPRESSION_SOURCES = ["manual", "system", "csv"] as const;

/** Who adds an entry one at a time, an opt-out among them: a user by hand, or the system. */
export const ENTRY_SOURCES = ["manual", "system"] as const;

/** A user's entry by hand: one that meets an exclusion list's entry takes it over (review-gaps). */
export const MANUAL_SOURCE = "manual" satisfies EntrySource;
/** An exclusion list's entry, which has its list. */
export const LIST_SOURCE = "csv" satisfies SuppressionSource;

/** What a never-contact entry is added for. */
export const SUPPRESSION_KINDS = ["person", "company"] as const;

/**
 * Why outreach is refused, in the order the check tries them, the first that applies wins: no such
 * person, then the entries on every channel, then, for a new enrollment, the last touch, then an
 * entry on one channel (matching.ts decide). A relationship entry answers never_contact_company:
 * campaigns' checkedCode throws on a code its list lacks, so this list gains none.
 */
export const SUPPRESSION_REASONS = [
  "person_not_found",
  "opted_out",
  "never_contact_person",
  "never_contact_company",
  "recently_contacted",
] as const;

/** The longest value a never-contact entry is typed with, as the URL rules read one. */
export const SUPPRESSION_VALUE_MAX = 2048;

/** The host a company's value may not name as a domain: a LinkedIn URL is a page or nothing. */
export const LINKEDIN_DOMAIN = "linkedin.com";

/** How often adding an entry writes again when the active one it met was removed meanwhile. */
export const WRITE_ATTEMPTS = 3;

export type SuppressionLayer = (typeof SUPPRESSION_LAYERS)[number];
export type AddLayer = (typeof ADD_LAYERS)[number];
export type SuppressionChannel = (typeof SUPPRESSION_CHANNELS)[number];
export type SuppressionRelationship = (typeof SUPPRESSION_RELATIONSHIPS)[number];
export type SuppressionMatchType = (typeof SUPPRESSION_MATCH_TYPES)[number];
export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number];
export type EntrySource = (typeof ENTRY_SOURCES)[number];
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number];
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

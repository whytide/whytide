// The never-contact list's words and limits (docs/concepts.md "Suppression entry"), beside the code
// that reads them: entries.ts, matching.ts, checks.ts, and the routes' schemas.

/** A new enrollment is refused while the person's last outbound touch is younger than this. */
export const RECENT_TOUCH_DAYS = 90;

/** A day, in milliseconds. */
export const DAY_MS = 86_400_000;

/** A domain entry, and each parent domain a company matches by, has at least this many labels. */
export const MIN_DOMAIN_LABELS = 2;

/** The workspace's blocks, and the person's own opt-outs, which are never removed. */
export const SUPPRESSION_LAYERS = ["blocklist", "opt_out"] as const;

/** What an entry's hash is of: a profile or company page URL, or a company's domain. */
export const SUPPRESSION_MATCH_TYPES = ["linkedin_url", "domain"] as const;

/** The channels an entry holds for: every one, until email sending (gamma). */
export const SUPPRESSION_CHANNELS = ["all"] as const;

/** Who added an entry: a user by hand, or the system (an opt-out found in a reply). */
export const SUPPRESSION_SOURCES = ["manual", "system"] as const;

/** What a never-contact entry is added for. */
export const SUPPRESSION_KINDS = ["person", "company"] as const;

/** Why outreach is refused, in the order the check tries them: the first that applies wins. */
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
export type SuppressionMatchType = (typeof SUPPRESSION_MATCH_TYPES)[number];
export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number];
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number];
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

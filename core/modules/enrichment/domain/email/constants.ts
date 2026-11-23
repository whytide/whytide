// The free email sources' names and bounds (README "The sources reply, website and pattern";
// gamma-en-085), beside their readers. Pure.

/** The sources' names in ENRICHMENT_EMAIL_SOURCES, each its provenance's provider too. */
export const REPLY = "reply";
export const WEBSITE_EMAIL = "website";
export const PATTERN = "pattern";
/** Their contact points' classes (`source_class`). */
export const SOURCE_CLASSES = {
  reply: "lead_reply",
  website: "website",
  pattern: "pattern",
} as const;

/**
 * The address patterns a domain may keep (the CHECKs email_domain_patterns_pattern and the older
 * email_domain_statuses_pattern list the same): `{first}` and `{last}` the cleaned names, `{f}` and
 * `{l}` their first letters. Their order breaks a tie between a domain's known patterns.
 */
export const PATTERNS = [
  "{first}.{last}",
  "{first}",
  "{f}{last}",
  "{first}{last}",
  "{f}.{last}",
  "{first}_{last}",
  "{last}",
  "{first}-{last}",
  "{last}.{first}",
  "{first}{l}",
] as const;
export type Pattern = (typeof PATTERNS)[number];
/** The guesses without a known pattern, in this order: the common patterns. */
export const COMMON_PATTERNS: readonly Pattern[] = PATTERNS.slice(0, 7);
/** A local part of two names joined by one of these gives its pattern directly. */
export const SEPARATOR_PATTERNS: Readonly<Record<string, Pattern>> = {
  ".": "{first}.{last}",
  _: "{first}_{last}",
  "-": "{first}-{last}",
};
/** Days a domain's pattern is read after it was last verified or seen (PATTERN_DAYS). */
export const PATTERN_DAYS = 180;
/** The guesses at most when the domain's patterns are known, the most proven first (gamma-rf-030). */
export const KNOWN_PATTERN_GUESSES = 2;

/** A full name counts for a site's address within this many characters of it. */
export const NAME_WINDOW = 200;
/** The addresses one site's pages give that are read at most. */
export const SITE_ADDRESSES_MAX = 100;
/** The pages the email source reads first after the home page: who to write to, then who they are. */
export const EMAIL_SITE_PREFERRED: readonly (readonly string[])[] = [
  ["contact", "contact-us"],
  ["team", "our-team", "people"],
  ["about", "about-us", "who-we-are"],
  ["imprint", "impressum"],
  ["legal"],
];
/** The email source's step: the 60-second read and a rendered page for each short one. */
export const WEBSITE_EMAIL_TIMEOUT_SECONDS = 150;

/** The sources' own words for a find with no candidate. */
export const OUTCOMES = {
  /** The pattern source: the domain is recorded catch-all, so no guess. */
  catchAllDomain: "catch_all_domain",
  /** The website source: no address of the lead's, but the domain's pattern written. */
  patternFound: "pattern_found",
  /** The pattern source: no candidate left in the lookup's bound, or no name to make one of. */
  noGuess: "no_guess",
} as const;

/** An address's local part and its domain, in characters, at most (RFC 5321). */
export const LOCAL_MAX = 64;
export const DOMAIN_MAX = 253;
export const LOCAL_CHAR = /[a-z0-9._%+-]/i;
export const DOMAIN_CHAR = /[a-z0-9.-]/i;
/** An address as read: a dotted local part, a domain of labels with a top-level one of letters. */
export const ADDRESS =
  /^[a-z0-9%+_-]+(?:\.[a-z0-9%+_-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

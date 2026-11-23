// web-search's words and bounds (README "Sources", docs/concepts.md "A company known only by
// name"): the source's name, the two searches and their fixed words, the names that are no company,
// the legal forms a name is compared without, and the hosts that are never a company's website.

/** The source's name in ENRICHMENT_COMPANY_SOURCES, and the stem of its counters. */
export const WEB_SEARCH = "web-search";
/** Each adapter's calls are counted under `web-search/<adapter>`. */
export const counterOf = (adapter: string): string => `${WEB_SEARCH}/${adapter}`;

/** The results each search asks for. */
export const RESULTS = 5;
/**
 * The LinkedIn page's search stays on this host: the port takes a host, never a path, so the pick
 * keeps the `/company/<slug>` pages (pick.ts).
 */
export const LINKEDIN_SITE = "linkedin.com";
/** The fixed words after the quoted name in the website's search. */
export const WEBSITE_WORDS = "official website";
/** The longest name searched; a longer one is no company's name (`not_a_company`). */
export const NAME_MAX = 150;
/** The shortest name searched, in characters, before cleaning. */
export const NAME_MIN = 2;
/**
 * The source's step's start-to-close timeout: two searches, each passed on to the next adapter
 * when one fails, an adapter's own timeout 10 seconds.
 */
export const WEB_SEARCH_TIMEOUT_SECONDS = 45;

/** What names.ts folds and drops: accents' marks, apostrophes, other punctuation, runs of spaces. */
export const MARKS = /\p{M}/gu;
export const APOSTROPHES = /['’`]/g;
export const NOT_A_WORD = /[^\p{L}\p{N}]+/gu;
export const SPACES = /\s+/g;

// What pick.ts reads of a result's link and title.
/** A page's handle as contacts keeps one: letters, digits, `_`, `-` and percent escapes. */
export const SLUG = /^[\w%-]{1,200}$/;
/** A title's LinkedIn ending, `| LinkedIn` or `- LinkedIn`. */
export const LINKEDIN_ENDING = /\s*[|\-–—]\s*linkedin\s*$/i;
/** A domain as contacts keeps one. */
export const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;
export const WWW = /^www\./;
export const NOT_ALPHANUMERIC = /[^a-z0-9]/g;

/** The outcomes the source answers in its own words. */
export const NOT_A_COMPANY = "not_a_company";
export const AMBIGUOUS = "ambiguous";
export const ALLOWANCE_SPENT = "allowance_spent";
/** PROVIDER_WEB_SEARCH loads no adapter: nothing to search with. */
export const NO_ADAPTER = "no_adapter";
/** The port's code of a vendor's word that its free searches are gone. */
export const VENDOR_SPENT = "web_search_allowance_spent";
/** An adapter that cannot load, when its error has no code. */
export const ADAPTER_LOAD_FAILED = "adapter_load_failed";

/** Employer names that are no company, compared in lower case with accents folded (names.ts). */
export const NOT_A_COMPANY_NAMES: readonly string[] = [
  "self-employed",
  "self employed",
  "selfemployed",
  "freelance",
  "freelancer",
  "independent",
  "independent consultant",
  "stealth",
  "stealth startup",
  "stealth mode",
  "confidential",
  "retired",
  "student",
  "unemployed",
  "open to work",
  "n/a",
  "none",
];

/** The legal forms dropped from a name's end before two names are compared, cleaned (names.ts). */
export const LEGAL_FORMS: readonly string[] = [
  "inc",
  "incorporated",
  "llc",
  "llp",
  "lp",
  "ltd",
  "limited",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "sarl",
  "srl",
  "spa",
  "bv",
  "nv",
  "plc",
  "pvt",
  "private",
  "pty",
  "corp",
  "corporation",
  "co",
  "company",
  "group",
  "holding",
  "holdings",
  "oy",
  "ab",
  "as",
  "aps",
  "kg",
  "kk",
];

/**
 * Hosts that are never a company's website: social networks, directories, news and job sites. An
 * entry with a dot is a host, matched with its subdomains; one without is a brand, matched by any
 * label of the host but its last (`glassdoor` matches www.glassdoor.co.uk).
 */
export const NOT_A_HOMEPAGE: readonly string[] = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  "reddit.com",
  "medium.com",
  "github.com",
  "wikipedia.org",
  "wikidata.org",
  "crunchbase.com",
  "bloomberg.com",
  "reuters.com",
  "forbes.com",
  "techcrunch.com",
  "zoominfo.com",
  "dnb.com",
  "apollo.io",
  "rocketreach.co",
  "craft.co",
  "owler.com",
  "pitchbook.com",
  "cbinsights.com",
  "opencorporates.com",
  "find-and-update.company-information.service.gov.uk",
  "bbb.org",
  "trustpilot.com",
  "g2.com",
  "capterra.com",
  "angel.co",
  "wellfound.com",
  "builtin.com",
  "ycombinator.com",
  "glassdoor",
  "indeed",
  "yelp",
  "monster",
  "ziprecruiter",
  "naukri",
  "yellowpages",
  "kompass",
  "play.google.com",
  "apps.apple.com",
];

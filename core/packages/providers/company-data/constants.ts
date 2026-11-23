// The company-data port's forms and bounds (README.md, the method's tables): the keys a lookup takes
// and the facts it answers. Lengths are counted as JavaScript counts them, in UTF-16 code units.

/**
 * A company's LinkedIn page, in one form: https://www.linkedin.com/company/<slug>, with no trailing
 * slash, query or fragment. The slug takes the characters of the LinkedIn port's company author
 * link (linkedin/constants.ts AUTHOR_PATHS), a dot and a percent escape included (/company/booking.com).
 */
export const COMPANY_PAGE = /^https:\/\/www\.linkedin\.com\/company\/[\w%.~-]{1,200}$/;
/**
 * A company's domain: a host name of two labels or more, lower case, without `www.`, as contacts
 * keeps one (its normalizeDomain), the last label starting with a letter.
 */
export const COMPANY_DOMAIN = /^(?!www\.)(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;
/** A host name's longest form. */
export const DOMAIN_MAX = 253;
/** A company's name: 1 to 200 characters, not blank. */
export const NAME_MAX = 200;
export const NOT_BLANK = /\S/;
/** ISO 3166-1 alpha-2, as two capital letters: the form, not the list. */
export const COUNTRY_CODE = /^[A-Z]{2}$/;

/** The facts' bounds: an industry's and a description's longest text, and a founding year's range. */
export const INDUSTRY_MAX = 200;
export const DESCRIPTION_MAX = 2000;
export const FOUNDED_YEAR_MIN = 1;
export const FOUNDED_YEAR_MAX = 9999;
/** An employee range starts at 0 (LinkedIn's "0-1 employees"); a count at 1. */
export const EMPLOYEE_RANGE_MIN = 0;
export const EMPLOYEE_COUNT_MIN = 1;

/**
 * The legal forms a company's name may end in (normalize.ts), dropped from its end, one word at a
 * time, once the name is folded: "GmbH & Co. KG" loses all three, "S.A." is "sa", "Ltd." is "ltd".
 */
export const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  ...["ab", "ag", "aps", "as", "asa", "bhd", "bv", "co", "company", "corp", "corporation"],
  ...["gmbh", "inc", "incorporated", "kg", "kk", "limited", "llc", "llp", "lp", "ltd", "ltda"],
  ...["nv", "oy", "oyj", "plc", "pllc", "pte", "pty", "pvt", "sa", "sarl", "sas", "sdn", "se"],
  ...["sl", "spa", "sro", "srl"],
]);
/** What a name loses before it is split: the dots and apostrophes inside a word, "S.A.", "Macy's". */
export const NAME_JOINERS = /[.'’]/g;
/** What separates a name's words once folded: anything but a letter or a digit. */
export const NAME_SEPARATORS = /[^\p{L}\p{N}]+/u;
/** The marks Unicode's NFKD splits off a letter: the accents a name is folded without. */
export const COMBINING_MARKS = /\p{M}/gu;
/** A website's schemes, and the label a domain is kept without. */
export const WEB_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);
export const WWW = "www.";
/** A text that ends in the first half of a surrogate pair, which a cut would leave alone. */
export const HIGH_SURROGATE_END = /[\uD800-\uDBFF]$/;
/**
 * A link a vendor gives without its scheme (Diffbot's `www.example.com`, People Data Labs'
 * `example.com`, `linkedin.com/company/example`), read as https where normalize.ts allows it.
 */
export const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
export const DEFAULT_SCHEME = "https://";
/**
 * A LinkedIn link as normalize.ts reads it (companyPageOf): on linkedin.com or one of its country
 * hosts (uk.linkedin.com), its path /company/<slug>, written back in COMPANY_PAGE's one form, which
 * starts with COMPANY_LINK (wikidata builds its pages from a slug the same way).
 */
export const LINKEDIN_HOST = "linkedin.com";
export const COMPANY_SEGMENT = "company";
export const COMPANY_LINK = "https://www.linkedin.com/company/";

/**
 * A country's English name to its code (normalize.ts, countryOf): ICU's English region names
 * (Intl.DisplayNames, every two-letter code tried), less the codes that are no country, plus the
 * names vendors give that ICU words otherwise: People Data Labs' canonical list (lower case: "hong
 * kong", "the gambia") and Diffbot's, Wikidata's labels ("united states of america", "people's
 * republic of china").
 */
export const COUNTRY_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const NOT_COUNTRIES: ReadonlySet<string> = new Set(
  "AC CP CQ DG EA EU EZ IC QO TA UN XA XB ZZ".split(" "),
);
export const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  "united states of america": "US",
  usa: "US",
  "united states minor outlying islands": "UM",
  uk: "GB",
  "great britain": "GB",
  "united kingdom of great britain and northern ireland": "GB",
  "peoples republic of china": "CN",
  "republic of ireland": "IE",
  "kingdom of the netherlands": "NL",
  "the netherlands": "NL",
  "czech republic": "CZ",
  turkey: "TR",
  "russian federation": "RU",
  "republic of korea": "KR",
  "hong kong": "HK",
  macau: "MO",
  macao: "MO",
  "viet nam": "VN",
  myanmar: "MM",
  "ivory coast": "CI",
  "cabo verde": "CV",
  "democratic republic of the congo": "CD",
  "republic of the congo": "CG",
  palestine: "PS",
  "state of palestine": "PS",
  "the gambia": "GM",
  "the bahamas": "BS",
  "saint vincent and the grenadines": "VC",
  "heard island and mcdonald islands": "HM",
  "south georgia and the south sandwich islands": "GS",
};

/** The block of deploy/.env.example the adapters' variables sit in (answer.ts, missingVariable). */
export const CONFIG_BLOCK = "packages/providers";
/** A vendor's answer (answer.ts): a redirect is never followed, so that a key never leaves its host. */
export const REDIRECT_STATUS = { min: 300, max: 399 } as const;
/** The statuses whose meaning every vendor shares: a refused key, its free calls gone, a rate limit. */
export const UNAUTHORIZED_STATUSES: ReadonlySet<number> = new Set([401, 403]);
export const PAYMENT_REQUIRED = 402;
export const TOO_MANY_REQUESTS = 429;
/** Retry-After in seconds; an HTTP date is read as the seconds until it. */
export const RETRY_AFTER = "retry-after";
export const RETRY_AFTER_SECONDS = /^\d{1,9}$/;
export const MS_PER_SECOND = 1000;
/** A network error's code as Node's fetch gives it in `error.cause.code` (ECONNREFUSED): kept in this short form only. */
export const NETWORK_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

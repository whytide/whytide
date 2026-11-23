// The web-search port's forms and bounds (README.md, the method's tables): what a search takes and
// the results it answers. Lengths are counted as JavaScript counts them, in UTF-16 code units.

/** A query: 1 to 200 characters, not blank. */
export const QUERY_MAX = 200;
export const NOT_BLANK = /\S/;
/**
 * A site: a host name of two labels or more, lower case, the last label starting with a letter;
 * `www.` allowed, since a site: operator keeps the results on the host it names and its subdomains.
 */
export const SITE = /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;
/** A host name's longest form. */
export const SITE_MAX = 253;
/** The results one search asks for, and answers at most. */
export const COUNT_MIN = 1;
export const COUNT_MAX = 10;
/** A result's link: https, at most this long. */
export const URL_MAX = 2048;
export const HTTPS = /^https$/;
/** A result's title's and snippet's longest text. */
export const TEXT_MAX = 300;

/** A country: ISO 3166-1 alpha-2, two capital letters; checked by form only. */
export const COUNTRY = /^[A-Z]{2}$/;
/** A language: ISO 639-1, two lower-case letters; checked by form only. */
export const LANGUAGE = /^[a-z]{2}$/;
/** The pages a search may ask for: 1 is the first `count` results, the default. */
export const PAGE_MIN = 1;
export const PAGE_MAX = 5;

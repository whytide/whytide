// The companies-house adapter's host, bounds and what it reads (README.md "Calls", "The match rule"):
// the Companies House public data API, a search by name and a company's profile.

/** The public data API: the adapter's one fixed host, and its two routes. */
export const API_URL = "https://api.company-information.service.gov.uk";
export const SEARCH_PATH = "/search/companies";
export const COMPANY_PATH = "/company/";
/** The search's results read: the first page, of this many. */
export const SEARCH_PAGE = "20";
export const MAX_ITEMS = 20;
/** A company's number as the register gives it: eight letters and digits (01234567, SC123456). */
export const COMPANY_NUMBER = /^[A-Z0-9]{8}$/;
/** The status of a company that trades: anything else (dissolved, liquidation…) is no answer. */
export const ACTIVE = "active";
/** The SIC codes a profile lists at most: four, as a filing allows. */
export const MAX_SIC_CODES = 4;
/** When the adapter runs: a hint of the United Kingdom, or a domain under .uk. */
export const UNITED_KINGDOM = "GB";
export const UK_DOMAIN = ".uk";
/** COMPANIES_HOUSE_API_KEY's form: printable, no space, no colon, so that it fits HTTP basic. */
export const API_KEY = /^[\x21-\x39\x3b-\x7e]{1,256}$/;

/** How long one request may take, its answer read to the end included. */
export const TIMEOUT_MS = 10_000;
/** The longest answer read, 256 KiB; a page of twenty results is far less. */
export const MAX_ANSWER_BYTES = 262_144;
/** The seconds a 429 asks to wait when its Retry-After gives none: the 5-minute window of its limit. */
export const RETRY_AFTER_SEC = 300;
export const JSON_TYPE = "application/json";

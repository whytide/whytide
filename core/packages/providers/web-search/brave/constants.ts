// The Brave adapter's fixed values (README.md): the one host and route it calls, the client's bounds,
// and what it reads of Brave's answers and errors, read on 2026-11-13 in Brave's Search API
// documentation (the web search's request and response, its rate-limiting guide) and its community
// forum (the error body of a refused key).

/** The one host the adapter calls, https only; a test hands its loopback address to braveWebSearch(). */
export const BASE_URL = "https://api.search.brave.com";
/** Brave's web search, GET with `q` and `count`. */
export const SEARCH_PATH = "/res/v1/web/search";
/** The header the key travels in, and nowhere else. */
export const KEY_HEADER = "x-subscription-token";
/** The answer's type the adapter asks for. */
export const ACCEPT = "application/json";
/**
 * Brave's own names for the country, the language and the page's offset. The offset counts pages
 * of `count` results, from 0, so the port's page is offset + 1; Brave allows 0 to 9.
 */
export const COUNTRY_PARAM = "country";
export const LANGUAGE_PARAM = "search_lang";
export const OFFSET_PARAM = "offset";
/**
 * The countries Brave's web search takes (its API reference, read on 2026-11-19); one it does not
 * list is searched without the filter, never refused.
 */
export const COUNTRIES: ReadonlySet<string> = new Set(
  "AR AU AT BE BR CA CL DK FI FR DE GR HK IN ID IT JP KR MY MX NL NZ NO CN PL PT PH RU SA ZA ES SE CH TW TR GB US".split(
    " ",
  ),
);
/**
 * The ISO 639-1 codes Brave's `search_lang` takes as they are, and the two-letter codes it takes
 * under another name: Brave splits Chinese by script and Portuguese by country, and writes
 * Norwegian as Bokmal. A code in neither is searched without the filter, never refused.
 */
export const LANGUAGES: ReadonlySet<string> = new Set(
  "ar eu bn bg ca hr cs da nl en et fi fr gl de el gu he hi hu is it ja kn ko lv lt ms ml mr nb pl pa ro ru sr sk sl es sv ta te th tr uk vi".split(
    " ",
  ),
);
export const LANGUAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ["zh", "zh-hans"],
  ["pt", "pt-pt"],
  ["no", "nb"],
]);
/** The operator that keeps Brave's results on a site, added to the query. */
export const SITE_OPERATOR = "site:";

/** How long one search may take, its answer read to the end included. */
export const TIMEOUT_MS = 10_000;
/** The longest answer the client reads, 1 MiB; a longer one is refused unparsed (answer_too_large). */
export const MAX_ANSWER_BYTES = 1024 * 1024;
/** A redirect's statuses: never followed, so that the key never leaves for another host. */
export const REDIRECT_STATUS = { min: 300, max: 399 } as const;

/** The statuses of a refused key: 401 and 403, and Brave's 422 with SUBSCRIPTION_TOKEN_INVALID. */
export const UNAUTHORIZED_STATUSES: ReadonlySet<number> = new Set([401, 403]);
export const UNAUTHORIZED_CODES: ReadonlySet<string> = new Set(["SUBSCRIPTION_TOKEN_INVALID"]);
/** The status of spent credits, and Brave's code for a plan's quota used up, whatever its status. */
export const PAYMENT_REQUIRED = 402;
export const QUOTA_CODES: ReadonlySet<string> = new Set(["QUOTA_LIMITED"]);
/** Brave's rate limit, and how long it asks to wait: Retry-After, else its X-RateLimit-Reset. */
export const RATE_LIMITED = 429;
export const RETRY_AFTER = "retry-after";
/** Seconds until each of the plan's windows resets, the shortest window first: `1, 1419704`. */
export const RATE_LIMIT_RESET = "x-ratelimit-reset";
export const SECONDS = /^\d{1,9}$/;
/** The wait when the answer gives none: the free plan's window is one second. */
export const RETRY_AFTER_SEC = 1;

/** Brave's error code (`error.code`) as an error's details keep it, and nothing else of the body. */
export const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** A network error's code as Node's fetch gives it in `error.cause.code` (`ECONNREFUSED`). */
export const NETWORK_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** A title's or a description's markup (Brave marks the query's words with <strong>), dropped. */
export const TAG = /<[^>]*>/g;
/** The entities Brave's text may hold, decoded in one pass, so that `&amp;lt;` stays `&lt;`. */
export const ENTITY = /&(?:amp|lt|gt|quot|nbsp|#39|#x27);/g;
export const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&nbsp;", " "],
  ["&#39;", "'"],
  ["&#x27;", "'"],
]);
export const SPACES = /\s+/g;

/** The results the live check's one search asks for (tests/contract.test.ts). */
export const LIVE_COUNT = 3;

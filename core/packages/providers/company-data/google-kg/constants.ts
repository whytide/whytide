// The google-kg adapter's host, bounds and what it reads of Google's answers (README.md "Calls",
// "Errors"): the Knowledge Graph Search API's one route, the key's header, and Google's error model.
import type { Allowance } from "../../_pattern/index.ts";

/** The Knowledge Graph Search API's search: the adapter's one fixed host and route. */
export const SEARCH_URL = "https://kgsearch.googleapis.com/v1/entities:search";
/** What a search asks besides the name: organizations, five at most. */
export const SEARCH = { types: "Organization", limit: "5" } as const;
export const MAX_RESULTS = 5;
/** The key travels in this header, never in the URL. */
export const KEY_HEADER = "x-goog-api-key";
/** GOOGLE_KG_API_KEY's form: printable, no space, so that it fits a header. */
export const API_KEY = /^[\x21-\x7e]{1,256}$/;
/** The free plan, 100,000 calls a day, when GOOGLE_KG_ALLOWANCE is empty. */
export const FREE_ALLOWANCE: Allowance = Object.freeze({ calls: 100_000, per: "day" });

/** How long one request may take, its answer read to the end included. */
export const TIMEOUT_MS = 10_000;
/** The longest answer read, 256 KiB; five results are far less. */
export const MAX_ANSWER_BYTES = 262_144;
/** The seconds a 429 asks to wait when its Retry-After gives none. */
export const RETRY_AFTER_SEC = 60;
export const JSON_TYPE = "application/json";

/**
 * Google's error model, google.rpc.Status with ErrorInfo details (`reason`, `metadata.quota_limit`),
 * and its older one, `errors[].reason`: a daily quota spent is the free calls gone, an invalid key the
 * key refused, a 403 rate limit (the older model) a rate limit.
 */
export const LIMIT_STATUSES: ReadonlySet<number> = new Set([403, 429]);
export const DAILY_QUOTA = /PerDay/i;
export const DAILY_REASONS: ReadonlySet<string> = new Set([
  "dailyLimitExceeded",
  "dailyLimitExceededUnreg",
]);
export const KEY_REASONS: ReadonlySet<string> = new Set(["API_KEY_INVALID", "keyInvalid"]);
export const RATE_REASONS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);
/** The details or errors read at most. */
export const MAX_ERROR_DETAILS = 20;

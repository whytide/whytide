// The companies-house adapter's HTTP client (README.md "Calls"): Node's fetch from this folder only,
// to the public data API, the exception docs/rules/security.md §5 makes for a vendor adapter. The key
// travels as HTTP basic's user, with no password, in the Authorization header and nowhere else. The
// answer is read as ../answer.ts reads every vendor's: its rate limit, 600 requests in 5 minutes, is
// company_data_rate_limited. No retry here.
import { exchange } from "../answer.ts";
import {
  COMPANY_PATH,
  JSON_TYPE,
  MAX_ANSWER_BYTES,
  RETRY_AFTER_SEC,
  SEARCH_PAGE,
  SEARCH_PATH,
  TIMEOUT_MS,
} from "./constants.ts";

export type CompaniesHouseClient = {
  /** The search's first page for a name, as JSON. */
  readonly search: (name: string) => Promise<unknown>;
  /** A company's profile by its number, as JSON. */
  readonly company: (number: string) => Promise<unknown>;
};

export function companiesHouseClient(
  apiUrl: string,
  apiKey: string,
  now: () => number,
): CompaniesHouseClient {
  const authorization = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  const answers = { maxBytes: MAX_ANSWER_BYTES, retryAfterSec: RETRY_AFTER_SEC, now };
  const get = (path: string, query: Readonly<Record<string, string>> = {}) => {
    const url = new URL(path, apiUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const headers = { accept: JSON_TYPE, authorization };
    const init = { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) } as const;
    return exchange(() => fetch(url, init), answers);
  };
  return {
    search: (name) => get(SEARCH_PATH, { q: name, items_per_page: SEARCH_PAGE }),
    company: (number) => get(`${COMPANY_PATH}${encodeURIComponent(number)}`),
  };
}

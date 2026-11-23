// The hunter adapter's one call (README.md "Covers"): Node's fetch, in this folder only, to Hunter's
// fixed host, GET Email Finder with the domain, the first name and the last name; the key in
// X-API-KEY and nowhere else. The answer is read as ../answer.ts reads every finder's, Hunter's own
// statuses first: its 403 is the rate limit, its 429 the usage limit, its 451 a person who claimed
// their data, read as not found. No retry here.
import { exchange, type Reading } from "../answer.ts";
import { JSON_TYPE } from "../constants.ts";
import type { FindEmailInput } from "../port.ts";
import {
  CLAIMED_STATUS,
  FINDER_PATH,
  KEY_HEADER,
  MAX_ANSWER_BYTES,
  RATE_LIMITED_STATUS,
  RETRY_AFTER_SEC,
  USAGE_LIMIT_STATUS,
} from "./constants.ts";

/** One Email Finder call: the answer's JSON, ../answer.ts's NOT_FOUND, or one of the port's codes. */
export type HunterClient = (input: FindEmailInput) => Promise<unknown>;

export function hunterClient(
  origin: string,
  apiKey: string,
  timeoutMs: number,
  now: () => number,
): HunterClient {
  const answers = { maxBytes: MAX_ANSWER_BYTES, retryAfterSec: RETRY_AFTER_SEC, now, read };
  return ({ firstName, lastName, companyDomain }) => {
    const url = new URL(FINDER_PATH, origin);
    url.searchParams.set("domain", companyDomain);
    url.searchParams.set("first_name", firstName);
    url.searchParams.set("last_name", lastName);
    const headers = { accept: JSON_TYPE, [KEY_HEADER]: apiKey };
    const init = { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) } as const;
    return exchange(() => fetch(url, init), answers);
  };
}

/** Hunter's own statuses; undefined, the shared reading. */
function read(status: number): Reading | undefined {
  if (status === RATE_LIMITED_STATUS) return "finder_rate_limited";
  if (status === USAGE_LIMIT_STATUS) return "finder_allowance_spent";
  if (status === CLAIMED_STATUS) return "not_found";
  return undefined;
}

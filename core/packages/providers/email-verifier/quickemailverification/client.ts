// The quickemailverification adapter's one call (README.md "Covers"): Node's fetch, in this folder
// only, to the vendor's fixed host, GET /v1/verify with the address and the key. The vendor takes its
// key in the query string only, so the URL is a secret: it lives in this function and goes to fetch,
// and nowhere else; no error, detail or log line holds it (../answer.ts keeps no cause, no Location,
// no body). Its statuses are the shared ones: 402 the credits gone, 401 and 403 a refused key or a
// disabled account, 429 the rate limit. No retry here.
import { type Answered, exchange } from "../answer.ts";
import { JSON_TYPE } from "../constants.ts";
import { MAX_ANSWER_BYTES, PARAM, RETRY_AFTER_SEC, VERIFY_PATH } from "./constants.ts";

/** One check: the answer's JSON, or one of the port's codes. */
export type QevClient = (address: string) => Promise<Answered>;

export function qevClient(
  origin: string,
  apiKey: string,
  timeoutMs: number,
  now: () => number,
): QevClient {
  const answers = { maxBytes: MAX_ANSWER_BYTES, retryAfterSec: RETRY_AFTER_SEC, now };
  return (address) => {
    const url = new URL(VERIFY_PATH, origin);
    url.searchParams.set(PARAM.email, address);
    url.searchParams.set(PARAM.key, apiKey);
    const headers = { accept: JSON_TYPE };
    const init = { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) } as const;
    return exchange(() => fetch(url, init), answers);
  };
}

// The zerobounce adapter's one call (README.md "Covers"): Node's fetch, in this folder only, to the
// vendor's fixed host, GET /v2/validate with the address and the key, never `ip_address`. The vendor
// takes its key in the query string only, so the URL is a secret: it lives in this function and goes
// to fetch, and nowhere else; no error, detail or log line holds it (../answer.ts keeps no cause, no
// Location, no body). The vendor's error answer, `{"error": …}`, at any status, is read by errorOf();
// any other failure by the shared reading of its status. No retry here.
import type { AppError } from "@whytide/platform";
import { type Answered, allowanceSpent, exchange, unauthorized } from "../answer.ts";
import { JSON_TYPE } from "../constants.ts";
import {
  CREDITS_MESSAGE,
  KEY_MESSAGE,
  MAX_ANSWER_BYTES,
  PARAM,
  RETRY_AFTER_SEC,
  VALIDATE_PATH,
} from "./constants.ts";

/** One check: the answer's JSON, or one of the port's codes. */
export type ZeroBounceClient = (address: string) => Promise<Answered>;

export function zeroBounceClient(
  origin: string,
  apiKey: string,
  timeoutMs: number,
  now: () => number,
): ZeroBounceClient {
  const answers = {
    maxBytes: MAX_ANSWER_BYTES,
    retryAfterSec: RETRY_AFTER_SEC,
    now,
    failure: errorOf,
  };
  return (address) => {
    const url = new URL(VALIDATE_PATH, origin);
    url.searchParams.set(PARAM.email, address);
    url.searchParams.set(PARAM.key, apiKey);
    const headers = { accept: JSON_TYPE };
    const init = { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) } as const;
    return exchange(() => fetch(url, init), answers);
  };
}

/**
 * The vendor's error answer at any status: naming the credits, the allowance spent; naming the key
 * alone, unauthorized; any other, or none, undefined. Its text is read, never kept.
 */
export function errorOf(status: number, body: unknown): AppError | undefined {
  const said = (body as { error?: unknown } | null)?.error;
  if (typeof said !== "string") return undefined;
  if (CREDITS_MESSAGE.test(said)) return allowanceSpent(status);
  if (KEY_MESSAGE.test(said)) return unauthorized(status);
  return undefined;
}

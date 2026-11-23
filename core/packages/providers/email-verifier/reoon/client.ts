// The reoon adapter's one call (README.md "Covers"): Node's fetch, in this folder only, to the
// vendor's fixed host, GET /api/v1/verify with the address, the key and power mode. The vendor takes
// its key in the query string only, so the URL is a secret: it lives in this function and goes to
// fetch, and nowhere else; no error, detail or log line holds it (../answer.ts keeps no cause, no
// Location, no body). The vendor's error answer, `{"status": "error", …}`, at any status, is read by
// errorOf(); any other failure by the shared reading of its status. No retry here.
import type { AppError } from "@whytide/platform";
import { type Answered, allowanceSpent, exchange, unauthorized } from "../answer.ts";
import { JSON_TYPE } from "../constants.ts";
import {
  CREDITS_REASON,
  ERROR_STATUS,
  KEY_REASON,
  MAX_ANSWER_BYTES,
  PARAM,
  POWER_MODE,
  RETRY_AFTER_SEC,
  VERIFY_PATH,
} from "./constants.ts";

/** One check: the answer's JSON, or one of the port's codes. */
export type ReoonClient = (address: string) => Promise<Answered>;

export function reoonClient(
  origin: string,
  apiKey: string,
  timeoutMs: number,
  now: () => number,
): ReoonClient {
  const answers = {
    maxBytes: MAX_ANSWER_BYTES,
    retryAfterSec: RETRY_AFTER_SEC,
    now,
    failure: errorOf,
  };
  return (address) => {
    const url = new URL(VERIFY_PATH, origin);
    url.searchParams.set(PARAM.email, address);
    url.searchParams.set(PARAM.key, apiKey);
    url.searchParams.set(PARAM.mode, POWER_MODE);
    const headers = { accept: JSON_TYPE };
    const init = { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) } as const;
    return exchange(() => fetch(url, init), answers);
  };
}

/**
 * The vendor's error answer at any status: a reason naming the credits or the balance, the allowance
 * spent; naming the key, unauthorized; any other, or none, undefined. Its text is read, never kept.
 */
export function errorOf(status: number, body: unknown): AppError | undefined {
  const answer = body as { status?: unknown; reason?: unknown } | null;
  if (answer?.status !== ERROR_STATUS || typeof answer.reason !== "string") return undefined;
  if (CREDITS_REASON.test(answer.reason)) return allowanceSpent(status);
  if (KEY_REASON.test(answer.reason)) return unauthorized(status);
  return undefined;
}

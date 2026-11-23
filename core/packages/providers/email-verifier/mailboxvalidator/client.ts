// The mailboxvalidator adapter's one call (README.md "Covers"): Node's fetch, in this folder only, to
// the vendor's fixed host, GET /v2/validation/single with the address and the key. The vendor takes
// its key in the query string only, so the URL is a secret: it lives in this function and goes to
// fetch, and nowhere else; no error, detail or log line holds it (../answer.ts keeps no cause, no
// Location, no body). The vendor answers every refusal with its own code, a 401 for the credits used
// too: errorOf() reads it first, then the shared reading by the status. No retry here.
import type { AppError } from "@whytide/platform";
import { type Answered, allowanceSpent, exchange, unauthorized } from "../answer.ts";
import { JSON_TYPE } from "../constants.ts";
import {
  INSUFFICIENT_CREDITS,
  KEY_REFUSED,
  MAX_ANSWER_BYTES,
  PARAM,
  RETRY_AFTER_SEC,
  VALIDATE_PATH,
} from "./constants.ts";

/** One check: the answer's JSON, or one of the port's codes. */
export type MbvClient = (address: string) => Promise<Answered>;

export function mbvClient(
  origin: string,
  apiKey: string,
  timeoutMs: number,
  now: () => number,
): MbvClient {
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
 * The vendor's own code, `error.error_code`, at any status: 10004 is the credits used, 10001 to 10003
 * a key refused; any other, or none, undefined.
 */
export function errorOf(status: number, body: unknown): AppError | undefined {
  const code = (body as { error?: { error_code?: unknown } | null } | null)?.error?.error_code;
  if (code === INSUFFICIENT_CREDITS) return allowanceSpent(status);
  if (typeof code === "number" && KEY_REFUSED.has(code)) return unauthorized(status);
  return undefined;
}

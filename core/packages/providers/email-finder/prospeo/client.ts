// The prospeo adapter's one call (README.md "Covers"): Node's fetch, in this folder only, to
// Prospeo's fixed host, POST Enrich Person with the first name, the last name and the company's
// website, and `only_verified_email`; the key in X-KEY and nowhere else. The answer is read as
// ../answer.ts reads every finder's, Prospeo's own error codes first: its errors are 400s whose body
// names them, NO_MATCH nobody found, INSUFFICIENT_CREDITS the credits gone, INVALID_API_KEY a
// refused key. No retry here.
import { exchange, type Reading } from "../answer.ts";
import { JSON_TYPE } from "../constants.ts";
import type { FindEmailInput } from "../port.ts";
import {
  ENRICH_PATH,
  ERROR_CODES,
  KEY_HEADER,
  MAX_ANSWER_BYTES,
  RETRY_AFTER_SEC,
} from "./constants.ts";

/** One Enrich Person call: the answer's JSON, ../answer.ts's NOT_FOUND, or one of the port's codes. */
export type ProspeoClient = (input: FindEmailInput) => Promise<unknown>;

export function prospeoClient(
  origin: string,
  apiKey: string,
  timeoutMs: number,
  now: () => number,
): ProspeoClient {
  const answers = { maxBytes: MAX_ANSWER_BYTES, retryAfterSec: RETRY_AFTER_SEC, now, read };
  return ({ firstName, lastName, companyDomain }) => {
    const url = new URL(ENRICH_PATH, origin);
    const body = JSON.stringify({
      only_verified_email: true,
      data: { first_name: firstName, last_name: lastName, company_website: companyDomain },
    });
    const headers = { accept: JSON_TYPE, "content-type": JSON_TYPE, [KEY_HEADER]: apiKey };
    const signal = AbortSignal.timeout(timeoutMs);
    const init = { method: "POST", headers, body, redirect: "manual", signal } as const;
    return exchange(() => fetch(url, init), answers);
  };
}

/** Prospeo's own error code, in the body's `error_code`; undefined, the shared reading by the status. */
function read(_status: number, text: string): Reading | undefined {
  let code: unknown;
  try {
    code = (JSON.parse(text) as { error_code?: unknown } | null)?.error_code;
  } catch {
    return undefined;
  }
  if (code === ERROR_CODES.noMatch) return "not_found";
  if (code === ERROR_CODES.noCredits) return "finder_allowance_spent";
  if (code === ERROR_CODES.badKey) return "finder_unauthorized";
  return undefined;
}

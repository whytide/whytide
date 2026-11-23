// The tomba adapter's one call (README.md "Covers"): Node's fetch, in this folder only, to Tomba's
// fixed host, GET Email Finder with the domain, the first name and the last name; the key and the
// secret in X-Tomba-Key and X-Tomba-Secret and nowhere else. The answer is read as ../answer.ts
// reads every finder's, by the status: Tomba's page documents no error of its own. No retry here.
import { exchange } from "../answer.ts";
import { JSON_TYPE } from "../constants.ts";
import type { FindEmailInput } from "../port.ts";
import {
  FINDER_PATH,
  KEY_HEADER,
  MAX_ANSWER_BYTES,
  RETRY_AFTER_SEC,
  SECRET_HEADER,
} from "./constants.ts";

/** One Email Finder call: the answer's JSON, or one of the port's codes. */
export type TombaClient = (input: FindEmailInput) => Promise<unknown>;

export function tombaClient(
  origin: string,
  credentials: { readonly key: string; readonly secret: string },
  timeoutMs: number,
  now: () => number,
): TombaClient {
  const answers = { maxBytes: MAX_ANSWER_BYTES, retryAfterSec: RETRY_AFTER_SEC, now };
  return ({ firstName, lastName, companyDomain }) => {
    const url = new URL(FINDER_PATH, origin);
    url.searchParams.set("domain", companyDomain);
    url.searchParams.set("first_name", firstName);
    url.searchParams.set("last_name", lastName);
    const headers = {
      accept: JSON_TYPE,
      [KEY_HEADER]: credentials.key,
      [SECRET_HEADER]: credentials.secret,
    };
    const init = { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) } as const;
    return exchange(() => fetch(url, init), answers);
  };
}

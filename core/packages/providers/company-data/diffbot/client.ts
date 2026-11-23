// The diffbot adapter's one call (README.md "Covers"): Node's fetch, in this folder only, to
// Diffbot's fixed host, GET Enhance with the one company key and the token. Diffbot takes its token
// in the query string only (its authentication page), so the URL is a secret: it lives in this
// function and goes to fetch, and nowhere else; no error, detail or log line holds it (../answer.ts
// keeps no cause, no Location, no body). The answer is read as ../answer.ts reads every vendor's,
// Diffbot's own failure first: a 429 whose message names the quota or the credits is the allowance
// spent; any other 429 the rate limit. No retry here.
import { AppError } from "@whytide/platform";
import { exchange } from "../answer.ts";
import { TOO_MANY_REQUESTS } from "../constants.ts";
import { companyDataPort } from "../port.ts";
import {
  ENHANCE_PATH,
  JSON_TYPE,
  MAX_ANSWER_BYTES,
  ORGANIZATION,
  PARAM,
  QUOTA_MESSAGE,
  RETRY_AFTER_SEC,
} from "./constants.ts";

const { errors } = companyDataPort;

/** The company key the call sends: the LinkedIn page or the domain as `url`, else the name. */
export type EnhanceKey = { readonly url: string } | { readonly name: string };
/** One Enhance call: the answer's JSON, or one of the port's codes. */
export type DiffbotClient = (key: EnhanceKey, threshold: number) => Promise<unknown>;

export function diffbotClient(
  origin: string,
  token: string,
  timeoutMs: number,
  now: () => number,
): DiffbotClient {
  const answers = { maxBytes: MAX_ANSWER_BYTES, retryAfterSec: RETRY_AFTER_SEC, now, failure };
  return (key, threshold) => {
    const url = new URL(ENHANCE_PATH, origin);
    url.searchParams.set(PARAM.type, ORGANIZATION);
    for (const [name, value] of Object.entries(key)) url.searchParams.set(name, value);
    url.searchParams.set(PARAM.threshold, String(threshold));
    url.searchParams.set(PARAM.token, token);
    const headers = { accept: JSON_TYPE };
    const init = { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) } as const;
    return exchange(() => fetch(url, init), answers);
  };
}

/**
 * Diffbot's own reading of a failure: a 429 whose message, `error` or `message`, names the quota or
 * the credits is the free credits gone. Else the shared reading, by the status.
 */
function failure(status: number, text: string): AppError | undefined {
  if (status !== TOO_MANY_REQUESTS) return undefined;
  let body: { error?: unknown; message?: unknown } | null;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return undefined;
  }
  const quota = [body?.error, body?.message].some(
    (said) => typeof said === "string" && QUOTA_MESSAGE.test(said),
  );
  return quota
    ? new AppError(errors.company_data_allowance_spent, { details: { status } })
    : undefined;
}

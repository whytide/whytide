// The pdl adapter's one call (README.md "Covers"): Node's fetch, in this folder only, to People Data
// Labs' fixed host, GET Company Enrichment with the one company key and min_likelihood; the key in
// X-Api-Key and nowhere else. The answer is read as ../answer.ts reads every vendor's: a 2xx answers
// its JSON, a 404 (no match) undefined, any other status one of the port's codes, with the status,
// never the body: a 402 the free calls gone, a 429 the rate limit. No retry here.
import { exchange } from "../answer.ts";
import {
  ENRICH_PATH,
  JSON_TYPE,
  KEY_HEADER,
  MAX_ANSWER_BYTES,
  NO_MATCH_STATUS,
  PARAM,
  RETRY_AFTER_SEC,
} from "./constants.ts";

/** The company key the call sends: the LinkedIn page, the website or the name. */
export type EnrichKey =
  | { readonly profile: string }
  | { readonly website: string }
  | { readonly name: string };
/** One Company Enrichment call: the match's JSON, undefined for none, or one of the port's codes. */
export type PdlClient = (key: EnrichKey, minLikelihood: number) => Promise<unknown>;

export function pdlClient(
  origin: string,
  apiKey: string,
  timeoutMs: number,
  now: () => number,
): PdlClient {
  const answers = {
    maxBytes: MAX_ANSWER_BYTES,
    retryAfterSec: RETRY_AFTER_SEC,
    now,
    notFound: NO_MATCH_STATUS,
  };
  return (key, minLikelihood) => {
    const url = new URL(ENRICH_PATH, origin);
    for (const [name, value] of Object.entries(key)) url.searchParams.set(name, value);
    url.searchParams.set(PARAM.minLikelihood, String(minLikelihood));
    const headers = { accept: JSON_TYPE, [KEY_HEADER]: apiKey };
    const init = { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) } as const;
    return exchange(() => fetch(url, init), answers);
  };
}

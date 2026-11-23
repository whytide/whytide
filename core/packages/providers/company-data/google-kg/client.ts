// The google-kg adapter's HTTP client (README.md "Calls"): Node's fetch from this folder only, to the
// Knowledge Graph Search API, the exception docs/rules/security.md §5 makes for a vendor adapter. The
// key travels in X-Goog-Api-Key and nowhere else; the URL holds the name and the search's two fixed
// parameters. The answer is read as ../answer.ts reads every vendor's, Google's own failures first: a
// daily quota spent, a key refused, a rate limit in its older error model. No retry here.
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { exchange } from "../answer.ts";
import { companyDataPort } from "../port.ts";
import {
  DAILY_QUOTA,
  DAILY_REASONS,
  JSON_TYPE,
  KEY_HEADER,
  KEY_REASONS,
  LIMIT_STATUSES,
  MAX_ANSWER_BYTES,
  MAX_ERROR_DETAILS,
  RATE_REASONS,
  RETRY_AFTER_SEC,
  SEARCH,
  TIMEOUT_MS,
} from "./constants.ts";

const { errors } = companyDataPort;

/** The search's answer for a name, as JSON. */
export function googleKgClient(searchUrl: string, apiKey: string, now: () => number) {
  const answers = { maxBytes: MAX_ANSWER_BYTES, retryAfterSec: RETRY_AFTER_SEC, now, failure };
  return (name: string): Promise<unknown> => {
    const url = new URL(searchUrl);
    for (const [key, value] of Object.entries({ query: name, ...SEARCH })) {
      url.searchParams.set(key, value);
    }
    const headers = { accept: JSON_TYPE, [KEY_HEADER]: apiKey };
    const init = { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) } as const;
    return exchange(() => fetch(url, init), answers);
  };
}

/** Google's errors, its current model's details and its older one's errors: their reasons and quota names. */
const reasons = z
  .array(
    z.object({
      reason: z.string().optional(),
      metadata: z.object({ quota_limit: z.string().optional() }).optional(),
    }),
  )
  .max(MAX_ERROR_DETAILS)
  .optional();
const googleError = z.object({ error: z.object({ details: reasons, errors: reasons }) });

/**
 * Google's own reading of a failure, from its reasons and quota names and nothing else of the body: a
 * daily quota spent is the free calls gone; an invalid key, the key refused; the older model's 403
 * rate limit, a rate limit. Else the shared reading, by the status.
 */
function failure(status: number, text: string): AppError | undefined {
  let error: z.infer<typeof googleError>["error"] | undefined;
  try {
    error = googleError.safeParse(JSON.parse(text)).data?.error;
  } catch {
    return undefined;
  }
  const all = [...(error?.details ?? []), ...(error?.errors ?? [])];
  const said = (known: ReadonlySet<string>) => all.some(({ reason }) => known.has(reason ?? ""));
  const daily = all.some(({ metadata }) => DAILY_QUOTA.test(metadata?.quota_limit ?? ""));
  if ((daily || said(DAILY_REASONS)) && LIMIT_STATUSES.has(status)) {
    return new AppError(errors.company_data_allowance_spent, { details: { status } });
  }
  if (said(KEY_REASONS)) {
    return new AppError(errors.company_data_unauthorized, { details: { status } });
  }
  if (said(RATE_REASONS) && LIMIT_STATUSES.has(status)) {
    const details = { retryAfterSec: RETRY_AFTER_SEC };
    return new AppError(errors.company_data_rate_limited, { details });
  }
  return undefined;
}

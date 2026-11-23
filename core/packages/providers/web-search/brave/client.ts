// The adapter's own HTTP client (README.md "Network"): Node's fetch to Brave's one route, the exception
// docs/rules/security.md §5 makes for a vendor adapter. The request is a GET with the query and the
// count, and the country, the language and the page's offset when the search gives them, and nothing else; the key travels in X-Subscription-Token and nowhere else. A redirect is
// never followed (`redirect: "manual"`), so that the key never follows one to another host: a 3xx is
// the provider error with its status and `reason: "redirect"`, its Location neither read nor kept.
// Any other answer is read up to MAX_ANSWER_BYTES, and a longer one refused unparsed. An answer that
// is not a 2xx becomes one of the port's codes with its status and Brave's short error code, never
// its body (README.md "Errors"); a request that gets no answer is `reason: "unreachable"` with the
// network error's short code, or `reason: "timeout"` past the timeout. No error keeps a cause, and
// nothing here logs: the URL holds the query.
import { AppError, isAppError } from "@whytide/platform";
import { webSearchPort } from "../port.ts";
import {
  ACCEPT,
  COUNTRY_PARAM,
  ERROR_CODE,
  KEY_HEADER,
  LANGUAGE_PARAM,
  MAX_ANSWER_BYTES,
  NETWORK_CODE,
  OFFSET_PARAM,
  PAYMENT_REQUIRED,
  QUOTA_CODES,
  RATE_LIMIT_RESET,
  RATE_LIMITED,
  REDIRECT_STATUS,
  RETRY_AFTER,
  RETRY_AFTER_SEC,
  SEARCH_PATH,
  SECONDS,
  UNAUTHORIZED_CODES,
  UNAUTHORIZED_STATUSES,
} from "./constants.ts";

/**
 * What the client sends: Brave's `q`, the site operator already in it, and `count`; and, when
 * given, Brave's `country`, `search_lang` and `offset` (a page index from 0), nothing else.
 */
export type BraveRequest = {
  readonly q: string;
  readonly count: number;
  readonly country?: string;
  readonly searchLang?: string;
  readonly offset?: number;
};
/** One search: the answer's JSON, or one of the port's codes. */
export type Client = (request: BraveRequest) => Promise<{ status: number; json: unknown }>;

const { errors } = webSearchPort;

export function braveClient(
  baseUrl: string,
  apiKey: string,
  now: () => number,
  timeoutMs: number,
): Client {
  return async ({ q, count, country, searchLang, offset }) => {
    const url = new URL(SEARCH_PATH, baseUrl);
    url.searchParams.set("q", q);
    url.searchParams.set("count", String(count));
    if (country !== undefined) url.searchParams.set(COUNTRY_PARAM, country);
    if (searchLang !== undefined) url.searchParams.set(LANGUAGE_PARAM, searchLang);
    if (offset !== undefined) url.searchParams.set(OFFSET_PARAM, String(offset));
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { accept: ACCEPT, [KEY_HEADER]: apiKey },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await answerOf(response);
    } catch (error) {
      throw isAppError(error) ? error : unanswered(error);
    }
    const { status } = response;
    if (!response.ok) throw vendorError(response, text, now());
    try {
      return { status, json: JSON.parse(text) as unknown };
    } catch {
      throw providerError({ status, reason: "not JSON" });
    }
  };
}

export const providerError = (details: Record<string, unknown>) =>
  new AppError(errors.web_search_provider_error, { details });

/** The answer's text, read up to MAX_ANSWER_BYTES: a redirect's or a longer one's is never read. */
async function answerOf(response: Response): Promise<string> {
  const { status } = response;
  if (status >= REDIRECT_STATUS.min && status <= REDIRECT_STATUS.max) {
    await response.body?.cancel().catch(() => undefined);
    throw providerError({ status, reason: "redirect" });
  }
  const tooLarge = providerError({ status, reason: "answer_too_large" });
  if (Number(response.headers.get("content-length")) > MAX_ANSWER_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop by the throw cancels the stream: the rest is never read.
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_ANSWER_BYTES) throw tooLarge;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A search that got no answer: past the timeout, else the network error by its short code. */
function unanswered(error: unknown): AppError {
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
    return providerError({ reason: "timeout" });
  }
  const code = (error as { cause?: { code?: unknown } | null } | null)?.cause?.code;
  const known = typeof code === "string" && NETWORK_CODE.test(code);
  return providerError({ reason: "unreachable", ...(known ? { code } : {}) });
}

/** Brave's error as the port's code: its quota, a refused key, its rate limit, or anything else. */
function vendorError(response: Response, text: string, now: number): AppError {
  const { status, headers } = response;
  const code = errorCode(text);
  const details = { status, ...(code === undefined ? {} : { code }) };
  if (status === PAYMENT_REQUIRED || (code !== undefined && QUOTA_CODES.has(code))) {
    return new AppError(errors.web_search_allowance_spent, { details });
  }
  if (UNAUTHORIZED_STATUSES.has(status) || (code !== undefined && UNAUTHORIZED_CODES.has(code))) {
    return new AppError(errors.web_search_unauthorized, { details });
  }
  if (status === RATE_LIMITED) {
    const retryAfterSec = waitOf(headers, now);
    return new AppError(errors.web_search_rate_limited, { details: { retryAfterSec } });
  }
  return providerError(details);
}

/** Brave's short error code, `error.code`, and nothing else of the body. */
function errorCode(text: string): string | undefined {
  try {
    const { error } = JSON.parse(text) as { error?: { code?: unknown } | null };
    const code = error?.code;
    return typeof code === "string" && ERROR_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The seconds to wait: Retry-After, as seconds or an HTTP date; else the first window of Brave's
 * X-RateLimit-Reset, its shortest; else RETRY_AFTER_SEC.
 */
function waitOf(headers: Headers, now: number): number {
  const retryAfter = headers.get(RETRY_AFTER)?.trim() ?? "";
  if (SECONDS.test(retryAfter)) return Math.max(1, Number(retryAfter));
  const at = Date.parse(retryAfter);
  if (!Number.isNaN(at)) return Math.max(1, Math.ceil((at - now) / 1000));
  const reset = headers.get(RATE_LIMIT_RESET)?.split(",")[0]?.trim() ?? "";
  return SECONDS.test(reset) ? Math.max(1, Number(reset)) : RETRY_AFTER_SEC;
}

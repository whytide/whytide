// A vendor's answer in the port's words (README.md "Adapters"), shared by the company-data adapters.
// Each adapter sends its own request with Node's fetch, from its own folder, on its fixed host, and
// hands it here: nothing in this file reaches the network. A redirect is never followed nor read; any
// other answer is read up to the adapter's bound, a longer one refused unread past it; the status an
// adapter names for no match (People Data Labs' 404) answers undefined; any other answer that is not a
// 2xx becomes one of the port's codes with its status, never its body, after the adapter's own reading
// of it (a vendor's "quota used"); a request that got no answer is the provider error with
// `reason` timeout or network, and the network error's short code. No vendor error is kept as a cause.
// An adapter started without a variable it requires fails with config_invalid, naming the variable.
import { AppError, isAppError } from "@whytide/platform";
import type { z } from "zod";
import {
  CONFIG_BLOCK,
  MS_PER_SECOND,
  NETWORK_CODE,
  PAYMENT_REQUIRED,
  REDIRECT_STATUS,
  RETRY_AFTER,
  RETRY_AFTER_SECONDS,
  TOO_MANY_REQUESTS,
  UNAUTHORIZED_STATUSES,
} from "./constants.ts";
import { companyDataPort } from "./port.ts";

const { errors } = companyDataPort;

export type Exchange = {
  /** The most of an answer's body the adapter reads, in bytes. */
  readonly maxBytes: number;
  /** The seconds a rate limit asks to wait when its Retry-After gives none. */
  readonly retryAfterSec: number;
  readonly now: () => number;
  /** The adapter's own reading of a failed answer, by its status and text; undefined, the shared one. */
  readonly failure?: (status: number, text: string) => AppError | undefined;
  /** The status the vendor answers when nothing matches: the exchange answers undefined for it. */
  readonly notFound?: number;
};

/** The JSON answer to `send()`'s request, undefined for `notFound`, or one of the port's codes. */
export async function exchange(send: () => Promise<Response>, options: Exchange): Promise<unknown> {
  let response: Response;
  let text: string;
  try {
    response = await send();
    text = await answerText(response, options.maxBytes);
  } catch (error) {
    throw isAppError(error) ? error : unanswered(error);
  }
  const { status } = response;
  if (status === options.notFound) return undefined;
  if (!response.ok) throw options.failure?.(status, text) ?? failure(response, options);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw providerError({ status, reason: "not_json" });
  }
}

/** The answer read against the vendor's documented shape, else the provider error. */
export function shaped<T>(schema: z.ZodType<T>, answer: unknown): T {
  const parsed = schema.safeParse(answer);
  if (!parsed.success) throw providerError({ reason: "off_shape" });
  return parsed.data;
}

export const providerError = (details: Record<string, unknown>) =>
  new AppError(errors.company_data_provider_error, { details });

/** An adapter started without a variable it requires: config_invalid, naming the variable, never a value. */
export const missingVariable = (variable: string, adapter: string) =>
  new AppError("config_invalid", {
    details: {
      block: CONFIG_BLOCK,
      variables: [`${variable}: required by the ${adapter} adapter`],
    },
  });

/** The answer's text, read up to `maxBytes`: a redirect's is never read, nor a longer one's past it. */
async function answerText(response: Response, maxBytes: number): Promise<string> {
  const { status } = response;
  if (status >= REDIRECT_STATUS.min && status <= REDIRECT_STATUS.max) {
    await response.body?.cancel().catch(() => undefined);
    throw providerError({ status, reason: "redirect" });
  }
  const tooLarge = providerError({ status, reason: "answer_too_large" });
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop by the throw cancels the stream: the rest is never read.
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw tooLarge;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A failed answer by its status: a rate limit, the free calls gone, a refused key, or anything else. */
function failure({ status, headers }: Response, { retryAfterSec, now }: Exchange): AppError {
  if (status === TOO_MANY_REQUESTS) {
    const seconds = secondsOf(headers.get(RETRY_AFTER), now(), retryAfterSec);
    return new AppError(errors.company_data_rate_limited, { details: { retryAfterSec: seconds } });
  }
  if (status === PAYMENT_REQUIRED) {
    return new AppError(errors.company_data_allowance_spent, { details: { status } });
  }
  if (UNAUTHORIZED_STATUSES.has(status)) {
    return new AppError(errors.company_data_unauthorized, { details: { status } });
  }
  return providerError({ status });
}

/** Retry-After as seconds or as an HTTP date; `fallback` when it gives neither. At least one second. */
function secondsOf(value: string | null, now: number, fallback: number): number {
  const text = value?.trim() ?? "";
  if (RETRY_AFTER_SECONDS.test(text)) return Math.max(1, Number(text));
  const at = Date.parse(text);
  return Number.isNaN(at) ? fallback : Math.max(1, Math.ceil((at - now) / MS_PER_SECOND));
}

/** A request that got no answer: past the timeout, else the network error by its short code. */
function unanswered(error: unknown): AppError {
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
    return providerError({ reason: "timeout" });
  }
  const code = (error as { cause?: { code?: unknown } | null } | null)?.cause?.code;
  const known = typeof code === "string" && NETWORK_CODE.test(code);
  return providerError({ reason: "network", ...(known ? { code } : {}) });
}

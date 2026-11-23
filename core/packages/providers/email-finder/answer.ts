// A vendor's answer in the port's words (README.md "Adapters"), shared by the email-finder adapters,
// as company-data/answer.ts is by its port's. Each adapter sends its own request with Node's fetch,
// from its own folder, on its fixed host, and hands it here: nothing in this file reaches the network.
// A redirect is never followed nor read; any other answer is read up to the adapter's bound, a longer
// one refused unread past it. A failed answer is read by the adapter first (its own statuses, its own
// error codes in the body: Hunter's 403 rate limit, Prospeo's NO_MATCH), then by the status every
// vendor shares; it becomes not_found or one of the port's codes with its status, never its body. A
// request that got no answer is the provider error with `reason` timeout or network. No vendor error
// is kept as a cause. The address a vendor found is checked against the port's form here, lower case.
import { AppError, isAppError } from "@whytide/platform";
import type { z } from "zod";
import {
  ADDRESS,
  ADDRESS_MAX,
  CONFIG_BLOCK,
  MS_PER_SECOND,
  NETWORK_CODE,
  PAYMENT_REQUIRED,
  REDIRECT_STATUS,
  RETRY_AFTER,
  RETRY_AFTER_SECONDS,
  TOO_MANY_REQUESTS,
  UNAUTHORIZED_STATUSES,
  type VENDOR_VERDICTS,
} from "./constants.ts";
import type { EmailFinderFailure } from "./contract.ts";
import { emailFinderPort, type FindEmailResult } from "./port.ts";

const { errors } = emailFinderPort;

/** How an adapter reads a failed answer: not found, or one of the port's codes. */
export type Reading = EmailFinderFailure | "not_found";

export type Exchange = {
  /** The most of an answer's body the adapter reads, in bytes. */
  readonly maxBytes: number;
  /** The seconds a rate limit asks to wait when its Retry-After gives none. */
  readonly retryAfterSec: number;
  readonly now: () => number;
  /** The adapter's own reading of a failed answer, by its status and text; undefined, the shared one. */
  readonly read?: (status: number, text: string) => Reading | undefined;
};

/** The JSON answer to `send()`'s request, NOT_FOUND when the vendor said so, or one of the port's codes. */
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
  if (!response.ok) {
    const reading = options.read?.(status, text) ?? sharedReading(status);
    if (reading === "not_found") return NOT_FOUND;
    throw failure(reading, response, options);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw providerError({ status, reason: "not_json" });
  }
}

/** What exchange() answers for a failed answer the vendor means as nobody found. */
export const NOT_FOUND: FindEmailResult = Object.freeze({ result: "not_found" });

/** The answer read against the vendor's documented shape, else the provider error. */
export function shaped<T>(schema: z.ZodType<T>, answer: unknown): T {
  const parsed = schema.safeParse(answer);
  if (!parsed.success) throw providerError({ reason: "off_shape" });
  return parsed.data;
}

/**
 * The vendor's address in the port's words: lower case, with its verdict when it gave one; nothing,
 * not_found; an address off the port's form, the provider error (never the address itself).
 */
export function foundOf(
  address: string | null | undefined,
  vendorVerdict: (typeof VENDOR_VERDICTS)[number] | undefined,
): FindEmailResult {
  const trimmed = address?.trim().toLowerCase() ?? "";
  if (trimmed === "") return NOT_FOUND;
  if (trimmed.length > ADDRESS_MAX || !ADDRESS.test(trimmed)) {
    throw providerError({ reason: "off_shape" });
  }
  return vendorVerdict === undefined
    ? { result: "found", address: trimmed }
    : { result: "found", address: trimmed, vendorVerdict };
}

export const providerError = (details: Record<string, unknown>) =>
  new AppError(errors.finder_provider_error, { details });

/** An adapter started without a variable it requires: config_invalid, naming the variable, never a value. */
export const missingVariable = (variable: string, adapter: string) =>
  new AppError("config_invalid", {
    details: {
      block: CONFIG_BLOCK,
      variables: [`${variable}: required by the ${adapter} adapter`],
    },
  });

/** A request that got no answer: past the timeout, else the network error by its short code. */
export function unanswered(error: unknown): AppError {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return providerError({ reason: "timeout" });
  const code = (error as { cause?: { code?: unknown } | null } | null)?.cause?.code;
  const known = typeof code === "string" && NETWORK_CODE.test(code);
  return providerError({ reason: "network", ...(known ? { code } : {}) });
}

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

/** A failed answer by the status every vendor shares. */
function sharedReading(status: number): Reading {
  if (status === TOO_MANY_REQUESTS) return "finder_rate_limited";
  if (status === PAYMENT_REQUIRED) return "finder_allowance_spent";
  if (UNAUTHORIZED_STATUSES.has(status)) return "finder_unauthorized";
  return "finder_provider_error";
}

/** The reading as the port's error: the rate limit with its wait, every other code with the status. */
function failure(
  reading: EmailFinderFailure,
  { status, headers }: Response,
  { retryAfterSec, now }: Exchange,
): AppError {
  if (reading === "finder_rate_limited") {
    const seconds = secondsOf(headers.get(RETRY_AFTER), now(), retryAfterSec);
    return new AppError(errors.finder_rate_limited, { details: { retryAfterSec: seconds } });
  }
  return new AppError(errors[reading], { details: { status } });
}

/** Retry-After as seconds or as an HTTP date; `fallback` when it gives neither. At least one second. */
function secondsOf(value: string | null, now: number, fallback: number): number {
  const text = value?.trim() ?? "";
  if (RETRY_AFTER_SECONDS.test(text)) return Math.max(1, Number(text));
  const at = Date.parse(text);
  return Number.isNaN(at) ? fallback : Math.max(1, Math.ceil((at - now) / MS_PER_SECOND));
}

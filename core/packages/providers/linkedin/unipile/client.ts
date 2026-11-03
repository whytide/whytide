// The adapter's own HTTP client (README.md "Network"): Node's fetch to the account's Unipile API,
// the exception docs/rules/security.md §5 makes for a vendor adapter. The key travels in X-API-KEY
// and nowhere else, and a redirect is never followed (`redirect: "manual"`), so that the key never
// follows one to another host: a 3xx is the provider error with its status and `reason: "redirect"`,
// its Location neither logged nor kept, its body not read. Any other answer is read up to
// MAX_ANSWER_BYTES, and a longer one refused unparsed (`reason: "answer_too_large"`). An answer that
// is not a 2xx becomes one of the port's codes with its status and the vendor's short error type
// (`errors/disconnected_account`), never its body (README.md "Errors"); a request that fails before
// any answer `reason: "unreachable"` with the network error's short code (`ECONNRESET`), never its
// message, or `reason: "timeout"` past TIMEOUT_MS; no vendor error is kept as a cause.
import { AppError, isAppError } from "@whytide/platform";
import { linkedinPort } from "../port.ts";
import {
  DISCONNECTED_TYPES,
  ERROR_TYPE,
  LIMIT_TYPES,
  MAX_ANSWER_BYTES,
  NETWORK_CODE,
  REDIRECT_STATUS,
  REFUSED_TYPES,
  RETRY_AFTER_SEC,
  TIMEOUT_MS,
  UNPROCESSABLE,
} from "./constants.ts";

export type Method = keyof typeof linkedinPort.methods;
export type Request = {
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Sent as JSON with a POST. */
  readonly body?: unknown;
  /** Sent as multipart/form-data with a POST: Unipile's chat routes take no JSON. */
  readonly form?: Readonly<Record<string, string>>;
  /** A DELETE; otherwise a POST with a body or a form, a GET without. */
  readonly verb?: "DELETE";
};
/** One call to the API: the answer's JSON, or one of the port's codes. */
export type Client = (method: Method, request: Request) => Promise<unknown>;

const { errors } = linkedinPort;

export function unipileClient(
  baseUrl: string,
  apiKey: string,
  now: () => number,
  timeoutMs = TIMEOUT_MS,
): Client {
  return async (method, request) => {
    const url = new URL(`/api/v1${request.path}`, baseUrl);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(name, value);
    }
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        ...init(request, apiKey),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await answerOf(method, response);
    } catch (error) {
      throw isAppError(error) ? error : unanswered(method, error);
    }
    if (!response.ok) throw vendorError(method, response, text, now());
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw providerError(method, { status: response.status, reason: "not JSON" });
    }
  };
}

export const providerError = (method: Method, details: Record<string, unknown>) =>
  new AppError(errors.linkedin_provider_error, { details: { method, ...details } });
export const notFound = (method: Method) =>
  new AppError(errors.linkedin_not_found, { details: { method } });
export const offShape = (method: Method) =>
  providerError(method, { reason: "an answer off the documented shape" });

/** An id as one path segment: encoded, never a dot segment, which the URL would resolve away. */
export function segment(id: string, method: Method): string {
  if (id === "." || id === "..") throw notFound(method);
  return encodeURIComponent(id);
}

function init({ body, form, verb }: Request, apiKey: string): RequestInit {
  const headers = { accept: "application/json", "x-api-key": apiKey };
  if (form !== undefined) {
    const data = new FormData();
    for (const [name, value] of Object.entries(form)) data.append(name, value);
    return { method: "POST", headers, body: data };
  }
  if (body === undefined) return { method: verb ?? "GET", headers };
  const json = { ...headers, "content-type": "application/json" };
  return { method: "POST", headers: json, body: JSON.stringify(body) };
}

/** The answer's text, read up to MAX_ANSWER_BYTES: a redirect's or a longer one's is never read. */
async function answerOf(method: Method, response: Response): Promise<string> {
  const { status } = response;
  if (status >= REDIRECT_STATUS.min && status <= REDIRECT_STATUS.max) {
    await response.body?.cancel().catch(() => undefined);
    throw providerError(method, { status, reason: "redirect" });
  }
  const tooLarge = providerError(method, { status, reason: "answer_too_large" });
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

/** A request that got no answer: past the timeout, else the network error by its short code. */
function unanswered(method: Method, error: unknown): AppError {
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
    return providerError(method, { reason: "timeout" });
  }
  const code = (error as { cause?: { code?: unknown } | null } | null)?.cause?.code;
  const known = typeof code === "string" && NETWORK_CODE.test(code);
  return providerError(method, { reason: "unreachable", ...(known ? { code } : {}) });
}

function vendorError(method: Method, response: Response, text: string, now: number): AppError {
  const { status } = response;
  if (status === 429) {
    const retryAfterSec = secondsOf(response.headers.get("retry-after"), now);
    return new AppError(errors.linkedin_rate_limited, { details: { method, retryAfterSec } });
  }
  if (status === 404) return notFound(method);
  const type = errorType(text);
  const known = type === undefined ? undefined : typed(method, status, type);
  return known ?? providerError(method, { status, ...(type === undefined ? {} : { type }) });
}

/** A vendor's error type the port has a code for: a disconnected account, a limit, a refusal. */
function typed(method: Method, status: number, type: string): AppError | undefined {
  const disconnected = DISCONNECTED_TYPES.get(type);
  if (disconnected !== undefined) {
    const details = { method, reason: disconnected, type };
    return new AppError(errors.linkedin_account_disconnected, { details });
  }
  if (status !== UNPROCESSABLE) return undefined;
  if (LIMIT_TYPES.has(type)) {
    return new AppError(errors.linkedin_limit_reached, { details: { method, type } });
  }
  const refused = REFUSED_TYPES.get(type);
  if (refused === undefined) return undefined;
  return new AppError(errors.linkedin_send_refused, { details: { method, reason: refused, type } });
}

/** The vendor's short error type, `errors/<reason>`, and nothing else of the body. */
function errorType(text: string): string | undefined {
  try {
    const { type } = JSON.parse(text) as { type?: unknown };
    return typeof type === "string" && ERROR_TYPE.test(type) ? type : undefined;
  } catch {
    return undefined;
  }
}

/** Retry-After as seconds or as an HTTP date; RETRY_AFTER_SEC when it gives neither. */
function secondsOf(value: string | null, now: number): number {
  const text = value?.trim() ?? "";
  if (/^\d{1,9}$/.test(text)) return Math.max(1, Number(text));
  const at = Date.parse(text);
  return Number.isNaN(at) ? RETRY_AFTER_SEC : Math.max(1, Math.ceil((at - now) / 1000));
}

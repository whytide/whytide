// The adapter's own HTTP client (README.md "Network"): Node's fetch to the account's Unipile API,
// the exception docs/rules/security.md §5 makes for a vendor adapter. The key travels in X-API-KEY
// and nowhere else, and a redirect is never followed (`redirect: "manual"`), so that the key never
// follows one to another host: a 3xx is the provider error with its status and `reason: "redirect"`,
// its Location neither logged nor kept. An answer that is not a 2xx becomes one of the port's codes
// with its status and the vendor's short error type (`errors/disconnected_account`), never its body;
// a request that fails before any answer `reason: "unreachable"` with the network error's short code
// (`ECONNRESET`), never its message; no vendor error is kept as a cause.
import { AppError } from "@whytide/platform";
import { linkedinPort } from "../port.ts";
import { NETWORK_CODE, REDIRECT_STATUS } from "./constants.ts";

export type Method = keyof typeof linkedinPort.methods;
export type Request = {
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Sent as JSON with a POST; a GET without it. */
  readonly body?: unknown;
};
/** One call to the API: the answer's JSON, or one of the port's codes. */
export type Client = (method: Method, request: Request) => Promise<unknown>;

const { errors } = linkedinPort;
/** The seconds a 429 asks to wait when its Retry-After gives none. */
export const RETRY_AFTER_SEC = 60;
const TIMEOUT_MS = 30_000;
/** The error types of an account that is disconnected or needs its credentials again. */
const DISCONNECTED = new Set([
  "errors/disconnected_account",
  "errors/expired_credentials",
  "errors/checkpoint_error",
]);
const ERROR_TYPE = /^errors\/[a-z_]{1,64}$/;

export function unipileClient(baseUrl: string, apiKey: string, now: () => number): Client {
  return async (method, { path, query = {}, body }) => {
    const url = new URL(`/api/v1${path}`, baseUrl);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const json = body === undefined ? {} : { "content-type": "application/json" };
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { accept: "application/json", "x-api-key": apiKey, ...json },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timeout = (error as { name?: unknown } | null)?.name === "TimeoutError";
      if (timeout) throw providerError(method, { reason: "timeout" });
      const code = networkCode(error);
      throw providerError(method, {
        reason: "unreachable",
        ...(code === undefined ? {} : { code }),
      });
    }
    if (!response.ok) throw await vendorError(method, response, now());
    try {
      return await response.json();
    } catch {
      throw providerError(method, { status: response.status, reason: "not JSON" });
    }
  };
}

export const providerError = (method: Method, details: Record<string, unknown>) =>
  new AppError(errors.linkedin_provider_error, { details: { method, ...details } });
export const notFound = (method: Method) =>
  new AppError(errors.linkedin_not_found, { details: { method } });

/** An id as one path segment: encoded, never a dot segment, which the URL would resolve away. */
export function segment(id: string, method: Method): string {
  if (id === "." || id === "..") throw notFound(method);
  return encodeURIComponent(id);
}

async function vendorError(method: Method, response: Response, now: number): Promise<AppError> {
  const { status } = response;
  const type = await errorType(response);
  if (status >= REDIRECT_STATUS.min && status <= REDIRECT_STATUS.max) {
    return providerError(method, { status, reason: "redirect" });
  }
  if (status === 429) {
    const retryAfterSec = secondsOf(response.headers.get("retry-after"), now);
    return new AppError(errors.linkedin_rate_limited, { details: { method, retryAfterSec } });
  }
  if (status === 404) return notFound(method);
  if (type !== undefined && DISCONNECTED.has(type)) {
    return new AppError(errors.linkedin_account_disconnected, { details: { method, type } });
  }
  return providerError(method, { status, ...(type === undefined ? {} : { type }) });
}

/** The vendor's short error type, `errors/<reason>`, and nothing else of the body. */
async function errorType(response: Response): Promise<string | undefined> {
  try {
    const { type } = (await response.json()) as { type?: unknown };
    return typeof type === "string" && ERROR_TYPE.test(type) ? type : undefined;
  } catch {
    return undefined;
  }
}

/** The network error's code, `error.cause.code` (`ECONNRESET`, `UND_ERR_SOCKET`), in that form only. */
function networkCode(error: unknown): string | undefined {
  const code = (error as { cause?: { code?: unknown } | null } | null)?.cause?.code;
  return typeof code === "string" && NETWORK_CODE.test(code) ? code : undefined;
}

/** Retry-After as seconds or as an HTTP date; RETRY_AFTER_SEC when it gives neither. */
function secondsOf(value: string | null, now: number): number {
  const text = value?.trim() ?? "";
  if (/^\d{1,9}$/.test(text)) return Math.max(1, Number(text));
  const at = Date.parse(text);
  return Number.isNaN(at) ? RETRY_AFTER_SEC : Math.max(1, Math.ceil((at - now) / 1000));
}

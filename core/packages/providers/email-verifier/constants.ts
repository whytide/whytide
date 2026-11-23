// The email-verifier port's forms and values (README.md, the method's table): the address it takes and
// the verdicts it answers. Lengths are counted as JavaScript counts them, in UTF-16 code units.

/**
 * The five verdicts of RB-7.1.1 and the data model's ContactPoint.verification, in that order.
 * `catch_all` is a verdict of its own, never folded into `valid`: "Verified emails only. No
 * guessing at catch-all domains" (what each means for sending is enrichment's, gamma-en-080).
 */
export const EMAIL_VERDICTS = ["valid", "catch_all", "risky", "invalid", "unknown"] as const;

/** An address's longest form: RFC 5321's path. */
export const ADDRESS_MAX = 254;
/**
 * An address, lower case, as contacts keeps one: a plain local part of letters, digits and `_'+-`,
 * dot-separated, at a host name of two labels or more, the last starting with a letter. No display
 * name, comment, quotes or space. Linear: a dot separates each repetition.
 */
export const ADDRESS = /^[a-z0-9_'+-]+(?:\.[a-z0-9_'+-]+)*@(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;

/** The block of deploy/.env.example the adapters' variables sit in (answer.ts, missingVariable). */
export const CONFIG_BLOCK = "packages/providers";
/** A vendor's answer (answer.ts): a redirect is never followed, so that a key never leaves its host. */
export const REDIRECT_STATUS = { min: 300, max: 399 } as const;
/** The statuses whose meaning every vendor shares: a refused key, its free checks gone, a rate limit. */
export const UNAUTHORIZED_STATUSES: ReadonlySet<number> = new Set([401, 403]);
export const PAYMENT_REQUIRED = 402;
export const TOO_MANY_REQUESTS = 429;
/** Retry-After in seconds; an HTTP date is read as the seconds until it. */
export const RETRY_AFTER = "retry-after";
export const RETRY_AFTER_SECONDS = /^\d{1,9}$/;
export const MS_PER_SECOND = 1000;
/** A network error's code as Node's fetch gives it in `error.cause.code` (ECONNREFUSED): kept in this short form only. */
export const NETWORK_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** What every adapter asks for. */
export const JSON_TYPE = "application/json";
/** A vendor's yes, as a JSON boolean or as text (QuickEmailVerification's `"true"`). */
export const YES: ReadonlySet<unknown> = new Set([true, "true", "True"]);

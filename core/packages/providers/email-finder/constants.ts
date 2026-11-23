// The email-finder port's forms and values (README.md, the method's tables): the person's keys a
// lookup takes and the address it answers. Lengths are counted as JavaScript counts them, in UTF-16
// code units.

/** A first or a last name: 1 to 100 characters, not blank. */
export const NAME_MAX = 100;
export const NOT_BLANK = /\S/;
/**
 * A company's domain: a host name of two labels or more, lower case, without `www.`, as the
 * company-data port takes one (company-data/constants.ts COMPANY_DOMAIN), the last label starting
 * with a letter.
 */
export const COMPANY_DOMAIN = /^(?!www\.)(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;
/** A host name's longest form. */
export const DOMAIN_MAX = 253;

/** An address's longest form: RFC 5321's path. */
export const ADDRESS_MAX = 254;
/**
 * An address, lower case, as the email-verifier port takes one (email-verifier/constants.ts
 * ADDRESS): a plain local part of letters, digits and `_'+-`, dot-separated, at a host name of two
 * labels or more, any domain. Linear: a dot separates each repetition.
 */
export const ADDRESS = /^[a-z0-9_'+-]+(?:\.[a-z0-9_'+-]+)*@(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;

/**
 * The verdicts a vendor's own check comes as: the email-verifier port's five
 * (email-verifier/constants.ts EMAIL_VERDICTS, the same list in the same order, which
 * tests/contract.test.ts asserts), so that `catch_all` is never folded into `valid` here either.
 */
export const VENDOR_VERDICTS = ["valid", "catch_all", "risky", "invalid", "unknown"] as const;

/** The block of deploy/.env.example the adapters' variables sit in (answer.ts, missingVariable). */
export const CONFIG_BLOCK = "packages/providers";
/** A vendor's answer (answer.ts): a redirect is never followed, so that a key never leaves its host. */
export const REDIRECT_STATUS = { min: 300, max: 399 } as const;
/** The statuses most vendors share: a refused key, the free searches gone, a rate limit. */
export const UNAUTHORIZED_STATUSES: ReadonlySet<number> = new Set([401, 403]);
export const PAYMENT_REQUIRED = 402;
export const TOO_MANY_REQUESTS = 429;
/** Retry-After in seconds; an HTTP date is read as the seconds until it. */
export const RETRY_AFTER = "retry-after";
export const RETRY_AFTER_SECONDS = /^\d{1,9}$/;
export const MS_PER_SECOND = 1000;
/** A network error's code as Node's fetch gives it in `error.cause.code` (ECONNREFUSED): kept in this short form only. */
export const NETWORK_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** The JSON type every finder's call asks for and sends. */
export const JSON_TYPE = "application/json";

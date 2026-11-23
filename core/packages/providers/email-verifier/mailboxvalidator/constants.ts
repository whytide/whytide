// The mailboxvalidator adapter's call and bounds (README.md "Covers"), read on 2026-11-13 in
// MailboxValidator's documentation: "Email Validation API" (v2, single validation) and its error codes.
import type { Allowance } from "../../_pattern/index.ts";

/** The API's fixed host and its one call. */
export const MBV_ORIGIN = "https://api.mailboxvalidator.com";
export const VALIDATE_PATH = "/v2/validation/single";
/** The call's two parameters: the address and the key, both in the query string (its documentation). */
export const PARAM = { email: "email", key: "key" } as const;

/** The key's variable, which `requires` names, and the free plan's allowance, the default. */
export const KEY_VARIABLE = "MAILBOXVALIDATOR_API_KEY";
/** 300 credits a month; the vendor counts 30 days from the sign-up, not the calendar month. */
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ calls: 300, per: "month" });

/** How long one check may take, its answer read to the end included (p0-050's 30 seconds). */
export const TIMEOUT_MS = 30_000;
/** The longest answer read: one address's verdict is under 1 KiB. */
export const MAX_ANSWER_BYTES = 64 * 1024;
/** The seconds a rate limit asks to wait when its Retry-After gives none. */
export const RETRY_AFTER_SEC = 60;

/**
 * The vendor's error codes, `error.error_code`, sent with a 401 or a 400 (its documentation): the
 * credits used, and a key not found, disabled or expired.
 */
export const INSUFFICIENT_CREDITS = 10004;
export const KEY_REFUSED: ReadonlySet<number> = new Set([10001, 10002, 10003]);

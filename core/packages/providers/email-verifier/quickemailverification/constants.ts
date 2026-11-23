// The quickemailverification adapter's call and bounds (README.md "Covers"), read on 2026-11-13 in
// QuickEmailVerification's documentation: "Verify an email address" and "Kick start with email
// validation API" (its HTTP codes).
import type { Allowance } from "../../_pattern/index.ts";

/** The API's fixed host and its one call. */
export const QEV_ORIGIN = "https://api.quickemailverification.com";
export const VERIFY_PATH = "/v1/verify";
/** The call's two parameters: the address and the key, both in the query string (its documentation). */
export const PARAM = { email: "email", key: "apikey" } as const;

/** The key's variable, which `requires` names, and the free plan's allowance, the default. */
export const KEY_VARIABLE = "QUICKEMAILVERIFICATION_API_KEY";
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ calls: 100, per: "day" });

/** How long one check may take, its answer read to the end included (p0-050's 30 seconds). */
export const TIMEOUT_MS = 30_000;
/** The longest answer read: one address's verdict is under 1 KiB. */
export const MAX_ANSWER_BYTES = 64 * 1024;
/** The seconds a rate limit asks to wait when its Retry-After gives none. */
export const RETRY_AFTER_SEC = 60;

/** The answer's `result` values, and the `reason` of a full mailbox ("exceeded_storage"). */
export const RESULT = { valid: "valid", invalid: "invalid", unknown: "unknown" } as const;
export const FULL_MAILBOX = "exceeded_storage";

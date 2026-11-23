// The zerobounce adapter's call and bounds (README.md "Covers"), read on 2026-11-13 in ZeroBounce's
// documentation: "Single Email Validator - Real time (v2)", its "Success / Fail Response" and
// "Status Codes (v2)".
import type { Allowance } from "../../_pattern/index.ts";

/** The API's default host (its EU and US hosts aside) and its one call. */
export const ZEROBOUNCE_ORIGIN = "https://api.zerobounce.net";
export const VALIDATE_PATH = "/v2/validate";
/** The call's two parameters: the address and the key, both in the query string (its documentation). */
export const PARAM = { email: "email", key: "api_key" } as const;

/** The key's variable, which `requires` names, and the free plan's allowance, the default. */
export const KEY_VARIABLE = "ZEROBOUNCE_API_KEY";
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ calls: 100, per: "month" });

/** How long one check may take, its answer read to the end included: the vendor's own default, 30 s. */
export const TIMEOUT_MS = 30_000;
/** The longest answer read: one address's verdict is under 2 KiB. */
export const MAX_ANSWER_BYTES = 64 * 1024;
/** The seconds a rate limit asks to wait when its Retry-After gives none: its block lasts a minute. */
export const RETRY_AFTER_SEC = 60;

/** The answer's `status` values the mapping names; the others are unknown. */
export const STATUS = { valid: "valid", invalid: "invalid", catchAll: "catch-all" } as const;
/** The statuses whose address exists but should not be mailed: spam traps, complainers, do-not-mail. */
export const RISKY_STATUSES: ReadonlySet<unknown> = new Set(["spamtrap", "abuse", "do_not_mail"]);
/** A valid address's sub-statuses on a domain that accepts every address. */
export const ACCEPT_ALL: ReadonlySet<unknown> = new Set(["accept_all", "role_based_accept_all"]);
/** An invalid address's sub-status for a full mailbox. */
export const FULL_MAILBOX = "mailbox_quota_exceeded";
/**
 * Its one error answer, `{"error":"Invalid API Key or your account ran out of credits"}`, names both
 * causes: an answer naming the credits is the allowance spent; one naming the key alone, unauthorized.
 */
export const CREDITS_MESSAGE = /credit/i;
export const KEY_MESSAGE = /api.?key/i;

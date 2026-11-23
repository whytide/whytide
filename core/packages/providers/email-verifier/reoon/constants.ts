// The reoon adapter's call and bounds (README.md "Covers"), read on 2026-11-13 in Reoon's "API
// Documentation of Reoon Email Verifier": single verification, power mode.
import type { Allowance } from "../../_pattern/index.ts";

/** The API's fixed host and its one call. */
export const REOON_ORIGIN = "https://emailverifier.reoon.com";
export const VERIFY_PATH = "/api/v1/verify";
/**
 * The call's parameters: the address and the key, both in the query string (its documentation), and
 * the mode. Power mode checks the mailbox itself and the catch-all domain; quick mode marks every
 * address of a good domain valid, so it is never used.
 */
export const PARAM = { email: "email", key: "key", mode: "mode" } as const;
export const POWER_MODE = "power";

/** The key's variable, which `requires` names, and the free plan's allowance, the default. */
export const KEY_VARIABLE = "REOON_API_KEY";
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ calls: 20, per: "day" });

/** How long one check may take, its answer read to the end included (p0-050's 30 seconds). */
export const TIMEOUT_MS = 30_000;
/** The longest answer read: one address's verdict is under 2 KiB. */
export const MAX_ANSWER_BYTES = 64 * 1024;
/** The seconds a rate limit asks to wait when its Retry-After gives none. */
export const RETRY_AFTER_SEC = 60;

/** The answer's `status` values, power mode's nine, by verdict; any other is unknown. */
export const SAFE = "safe";
export const CATCH_ALL = "catch_all";
export const INVALID_STATUSES: ReadonlySet<unknown> = new Set(["invalid", "disabled"]);
export const RISKY_STATUSES: ReadonlySet<unknown> = new Set([
  "disposable",
  "inbox_full",
  "role_account",
  "spamtrap",
]);
/**
 * Its error answer, `{"status": "error", "reason": …}`, at any status: a reason naming the credits or
 * the balance is the allowance spent; one naming the key, unauthorized.
 */
export const ERROR_STATUS = "error";
export const CREDITS_REASON = /credit|balance|quota/i;
export const KEY_REASON = /key/i;

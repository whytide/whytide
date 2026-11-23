// The snov adapter's calls and bounds (README.md "Covers"), read on 2026-11-13 in Snov.io's API
// documentation (snov.io/api): the access token, Email Finder by name and domain (v2, its start and
// its result) and the rate limit.
import type { Allowance } from "../../_pattern/index.ts";

/** Snov.io's fixed host and its three calls. */
export const SNOV_ORIGIN = "https://api.snov.io";
export const TOKEN_PATH = "/v1/oauth/access_token";
export const START_PATH = "/v2/emails-by-domain-by-name/start";
export const RESULT_PATH = "/v2/emails-by-domain-by-name/result";
/** The token call's grant, and the bearer scheme the token travels in. */
export const GRANT_TYPE = "client_credentials";
export const BEARER = "Bearer";
export const FORM_TYPE = "application/x-www-form-urlencoded";

/** The variables `requires` names, and the free plan's allowance, the default. */
export const ID_VARIABLE = "SNOV_CLIENT_ID";
export const SECRET_VARIABLE = "SNOV_CLIENT_SECRET";
/** 50 credits a month: one per address found, `valid` or `unknown`. */
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ calls: 50, per: "month" });

/** The lookup's whole budget, the token, the start and every read of the result included. */
export const BUDGET_MS = 10_000;
/** The wait before each read of the result: at most five reads in the budget, under 60 calls a minute. */
export const POLL_MS = 2_000;
/** A token is fetched again this long before Snov.io says it expires. */
export const TOKEN_MARGIN_SEC = 60;
/** The longest answer read, 256 KiB. */
export const MAX_ANSWER_BYTES = 256 * 1024;
/** The seconds a rate limit asks to wait when it gives none: Snov.io counts 60 calls a minute. */
export const RETRY_AFTER_SEC = 60;
/** The status that sends the token call again, once. */
export const UNAUTHORIZED_STATUS = 401;
/** The OAuth errors (RFC 6749 §5.2) that mean the client's id or secret was refused. */
export const REFUSED_CLIENT: ReadonlySet<string> = new Set([
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
]);

/** The result's statuses (README.md "Mapping"). */
export const TASK_STATUS = {
  completed: "completed",
  inProgress: "in_progress",
  noCredits: "not_enough_credits",
} as const;
/** An address's SMTP status, and the reason Snov.io gives for an unknown one that is a catch-all. */
export const SMTP_VALID = "valid";
export const SMTP_UNKNOWN = "unknown";
export const CATCH_ALL_REASON = "catchall";

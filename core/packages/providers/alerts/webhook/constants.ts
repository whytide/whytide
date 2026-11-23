// The webhook adapter's bounds and what it reads of an answer (README.md "Covers").

/** The variable that holds the team channel's incoming webhook URL, a secret. */
export const URL_VARIABLE = "ALERTS_WEBHOOK_URL";

/** How long one post may take, the answer's head and the bounded read of its body included. */
export const ALERTS_TIMEOUT_MS = 10_000;

/** The most of an answer's body the adapter reads, 16 KiB; it drops what it read and never reads on. */
export const ALERTS_ANSWER_MAX_BYTES = 16_384;

/** The body's type: the text goes as `{"text": …}`, which Slack, Discord's /slack address and a Teams workflow take. */
export const CONTENT_TYPE = "application/json";

/** The scheme the URL has, unless its host is on EGRESS_ALLOW_HOSTS (a test's local server). */
export const HTTPS = "https:";

/** The answers that took the text. */
export const TAKEN = { min: 200, max: 299 } as const;
/** The answers that refused it for good: a redirect, never followed, and a 4xx but RATE_LIMITED. */
export const REFUSED = { min: 300, max: 499 } as const;
/** The answer that asks to wait, for the seconds its Retry-After gives. */
export const RATE_LIMITED = 429;
export const RETRY_AFTER = "retry-after";
/** Retry-After in seconds, as Slack, Discord and Teams send it; an HTTP date gives no retryAfterSec. */
export const RETRY_AFTER_SECONDS = /^\d{1,9}$/;

/** Why nothing answered, in alerts_unreachable's `details.reason`. */
export const NO_ANSWER = { timeout: "timeout", network: "network" } as const;
/** A network error's code as Node's fetch gives it in `error.cause.code` (ECONNREFUSED): kept in this short form only. */
export const NETWORK_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Why create() refuses the URL, after the variable's name in config_invalid's `details.variables`. */
export const REFUSALS = {
  required: "required by the webhook adapter",
  insecure: "https, or http to a host on EGRESS_ALLOW_HOSTS",
  /** Followed by the rule's code: egress_credentials_in_url, egress_denied_host and the rest. */
  egress: "refused by the egress rules,",
  unparsed: "not a URL",
} as const;

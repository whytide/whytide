// The hunter adapter's call and bounds (README.md "Covers"), read on 2026-11-13 in Hunter's API
// documentation, v2: Email Finder, Authentication, Errors and Rate limiting.
import type { Allowance } from "../../_pattern/index.ts";
import type { VENDOR_VERDICTS } from "../constants.ts";

/** Hunter's fixed host and its Email Finder call. */
export const HUNTER_ORIGIN = "https://api.hunter.io";
export const FINDER_PATH = "/v2/email-finder";
/** The key travels in this header, never in the URL (Hunter also takes `api_key` there: never used). */
export const KEY_HEADER = "x-api-key";

/** The key's variable, which `requires` names, and the free plan's allowance, the default. */
export const KEY_VARIABLE = "HUNTER_API_KEY";
/** 50 credits a month, shared with Hunter's own verifier, which the adapter never calls. */
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ calls: 50, per: "month" });

/** How long one call may take: Hunter's own search runs up to 10 s by default (`max_duration`). */
export const TIMEOUT_MS = 30_000;
/** The longest answer read, 256 KiB: an answer with its 20 sources is a few KiB. */
export const MAX_ANSWER_BYTES = 256 * 1024;
/** The seconds a rate limit asks to wait when it gives none: Hunter counts 500 calls a minute. */
export const RETRY_AFTER_SEC = 60;

/**
 * Hunter's own statuses, where they differ from the shared reading (README.md "Mapping"): its 403 is
 * the rate limit, its 429 the plan's usage limit, its 451 a person who asked Hunter not to process
 * their data (`claimed_email`).
 */
export const RATE_LIMITED_STATUS = 403;
export const USAGE_LIMIT_STATUS = 429;
export const CLAIMED_STATUS = 451;

/** Hunter's verification status, and its accept_all flag, as the port's verdicts. */
export const VERDICTS: Readonly<Record<string, (typeof VENDOR_VERDICTS)[number]>> = {
  valid: "valid",
  accept_all: "catch_all",
  webmail: "risky",
  disposable: "risky",
  invalid: "invalid",
  unknown: "unknown",
};

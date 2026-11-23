// The tomba adapter's call and bounds (README.md "Covers"), read on 2026-11-13 on Tomba's API page
// (tomba.io/api): the Email Finder, the two headers, the plans' rate limits and the free plan.
import type { Allowance } from "../../_pattern/index.ts";
import type { VENDOR_VERDICTS } from "../constants.ts";

/** Tomba's fixed host and its Email Finder call. */
export const TOMBA_ORIGIN = "https://api.tomba.io";
export const FINDER_PATH = "/v1/email-finder";
/** The key and the secret travel in these two headers, never in the URL. */
export const KEY_HEADER = "x-tomba-key";
export const SECRET_HEADER = "x-tomba-secret";

/** The variables `requires` names, and the free plan's allowance, the default. */
export const KEY_VARIABLE = "TOMBA_KEY";
export const SECRET_VARIABLE = "TOMBA_SECRET";
/** 25 search credits every 30 days. */
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ calls: 25, per: "month" });

/** How long one call may take (p0-050's 30 seconds). */
export const TIMEOUT_MS = 30_000;
/** The longest answer read, 256 KiB: an answer with its sources is a few KiB. */
export const MAX_ANSWER_BYTES = 256 * 1024;
/** The seconds a rate limit asks to wait when it gives none: the free plan's limit is per minute. */
export const RETRY_AFTER_SEC = 60;

/** Tomba's verification status, and its accept_all flag, as the port's verdicts. */
export const VERDICTS: Readonly<Record<string, (typeof VENDOR_VERDICTS)[number]>> = {
  valid: "valid",
  accept_all: "catch_all",
  webmail: "risky",
  disposable: "risky",
  invalid: "invalid",
  unknown: "unknown",
};

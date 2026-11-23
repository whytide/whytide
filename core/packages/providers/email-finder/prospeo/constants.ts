// The prospeo adapter's call and bounds (README.md "Covers"), read on 2026-11-13 in Prospeo's API
// documentation: Enrich Person (prospeo.io/api-docs/enrich-person), its matching rules, its response
// and its error codes.
import type { Allowance } from "../../_pattern/index.ts";

/** Prospeo's fixed host and its Enrich Person call. */
export const PROSPEO_ORIGIN = "https://api.prospeo.io";
export const ENRICH_PATH = "/enrich-person";
/** The key travels in this header, never in the URL or the body. */
export const KEY_HEADER = "x-key";

/** The key's variable, which `requires` names, and the free plan's allowance, the default. */
export const KEY_VARIABLE = "PROSPEO_API_KEY";
/** 75 credits a month: one per address found; nothing found costs nothing. */
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ calls: 75, per: "month" });

/** How long one call may take (p0-050's 30 seconds). */
export const TIMEOUT_MS = 30_000;
/** The longest answer read, 256 KiB: a person's and a company's records are tens of KiB. */
export const MAX_ANSWER_BYTES = 256 * 1024;
/** The seconds a rate limit asks to wait when it gives none. */
export const RETRY_AFTER_SEC = 60;

/** Prospeo's error codes, in its error body's `error_code`, that the adapter reads (README.md "Mapping"). */
export const ERROR_CODES = {
  noMatch: "NO_MATCH",
  noCredits: "INSUFFICIENT_CREDITS",
  badKey: "INVALID_API_KEY",
} as const;
/** The status of an address Prospeo verified itself: the port's `valid`. */
export const VERIFIED = "VERIFIED";

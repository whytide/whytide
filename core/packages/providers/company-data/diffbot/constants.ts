// The diffbot adapter's call and bounds (README.md "Covers"), read on 2026-11-13 in Diffbot's
// documentation: Enhance (GET), its authentication, rate limits and credits pages.
import type { Allowance } from "../../_pattern/index.ts";

/** The Knowledge Graph's fixed host and its Enhance call. */
export const DIFFBOT_ORIGIN = "https://kg.diffbot.com";
export const ENHANCE_PATH = "/kg/v3/enhance";
/** The call's parameters: the entity type, the one company key sent, the score threshold, the token. */
export const PARAM = {
  type: "type",
  url: "url",
  name: "name",
  threshold: "threshold",
  token: "token",
} as const;
export const ORGANIZATION = "Organization";

/**
 * The least score a match needs, sent as the call's `threshold` and checked again on the answer, so
 * that a weak match is not_found whatever the vendor answers. Diffbot's own default (about 0.3) errs
 * on the side of recall; a wrong company's facts are worse than none.
 */
export const MIN_SCORE = 0.5;

/** The token's variable, which `requires` names, and the free plan's allowance, the default. */
export const TOKEN_VARIABLE = "DIFFBOT_TOKEN";
/** 10,000 credits a month at 25 a matched company. */
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ calls: 400, per: "month" });

/** How long one call may take, its answer read to the end included. */
export const TIMEOUT_MS = 10_000;
/** The longest answer read, 4 MiB: a large company's entity carries many locations and names. */
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

export const JSON_TYPE = "application/json";
/**
 * A 429 is the rate limit (5 calls a minute on the free plan) or the plan's credits used ("429
 * Quota Exceeded"): its message, `error` or `message`, tells them apart, and nothing else of it is
 * kept. ../answer.ts reads every other status.
 */
export const QUOTA_MESSAGE = /quota|credit/i;
/** The seconds a rate limit asks to wait when its Retry-After gives none: the free plan's minute. */
export const RETRY_AFTER_SEC = 60;

/** A founding date's text, `d2008-XX-XX`: its year. */
export const FOUNDING_YEAR = /^d?(\d{1,4})-/;

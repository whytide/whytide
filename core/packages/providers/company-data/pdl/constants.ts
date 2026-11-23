// The pdl adapter's call and bounds (README.md "Covers"), read on 2026-11-13 in People Data Labs'
// documentation: Company Enrichment's reference, input parameters and output, the company schema,
// its company sizes, the errors and the authentication pages.
import type { Allowance } from "../../_pattern/index.ts";

/** People Data Labs' fixed host and its Company Enrichment call. */
export const PDL_ORIGIN = "https://api.peopledatalabs.com";
export const ENRICH_PATH = "/v5/company/enrich";
/** The call's parameters: the one company key sent and the least likelihood of a match. */
export const PARAM = {
  profile: "profile",
  website: "website",
  name: "name",
  minLikelihood: "min_likelihood",
} as const;
/** The key travels in this header, never in the URL. */
export const KEY_HEADER = "x-api-key";

/** The key's variable, which `requires` names, and the free plan's allowance, the default. */
export const KEY_VARIABLE = "PDL_API_KEY";
/** 100 company enrichments a month. */
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ calls: 100, per: "month" });
/** PDL_MIN_LIKELIHOOD: its range, 1 to 10, and the default, 6, PDL's advice for high accuracy. */
export const LIKELIHOOD = { min: 1, max: 10, default: 6 } as const;

/** How long one call may take, its answer read to the end included. */
export const TIMEOUT_MS = 10_000;
/** The longest answer read, 1 MiB: a company's record is tens of KiB. */
export const MAX_ANSWER_BYTES = 1024 * 1024;

export const JSON_TYPE = "application/json";
/** PDL's answer when no company matches at min_likelihood; ../answer.ts reads every other status. */
export const NO_MATCH_STATUS = 404;
/** The seconds a rate limit asks to wait when its Retry-After gives none (10 calls a minute free). */
export const RETRY_AFTER_SEC = 60;

/** A canonical size, `11-50`, or the open one, `10001+`. */
export const SIZE_RANGE = /^(\d{1,9})-(\d{1,9})$/;
export const SIZE_OPEN = /^(\d{1,9})\+$/;

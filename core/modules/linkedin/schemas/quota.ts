// The inputs of the read quota and the action log (README.md "Read quota"), which code calls, and the
// usage route's answer, from which the api host builds the OpenAPI document.
import { z } from "zod";

const LINKEDIN_HOSTS = new Set(["linkedin.com", "www.linkedin.com"]);
const PERSON_ID = /^per_[0-9A-HJKMNP-TV-Z]{26}$/;
const COLON = "(?::|%3[Aa])";
const POST_PATH = new RegExp(
  `^/(?:posts/[\\w%.~-]+|feed/update/urn${COLON}li${COLON}(?:activity|share|ugcPost)${COLON}\\d{1,30})/?$`,
);

/**
 * A person's id (`per_…`) or a LinkedIn post's URL, https, with no query or fragment: never a
 * profile's URL, which names a person who may not be a person of ours (docs/security.md).
 */
export function isObjectRef(value: string): boolean {
  if (PERSON_ID.test(value)) return true;
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const plain = url.protocol === "https:" && !url.username && !url.port && !url.search && !url.hash;
  return plain && LINKEDIN_HOSTS.has(url.hostname) && POST_PATH.test(url.pathname);
}

const accountId = z.string().min(1).max(64);
const objectRef = z.string().max(2048).refine(isObjectRef);
export const actionKinds = ["read_engagers", "read_profile", "status_check"] as const;

export const reserveInput = z.strictObject({
  accountId,
  /** Reads: an engager-list page counts one, a profile one. */
  count: z.int().min(1).max(1000),
  kind: z.enum(["read_engagers", "read_profile"]),
  objectRef: objectRef.optional(),
});
export type ReserveInput = z.input<typeof reserveInput>;

const reservationId = z.string().min(1).max(64);
/** `actual`: the reads made, counted as made, above the reservation too. */
export const commitInput = z.strictObject({ reservationId, actual: z.int().min(0).max(1000) });
export const releaseInput = z.strictObject({ reservationId });

export const logInput = z.strictObject({
  accountId,
  kind: z.enum(actionKinds),
  objectRef: objectRef.optional(),
  count: z.int().min(0).max(1000),
  /** `ok`, or a code: `linkedin_rate_limited`. */
  outcome: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
});
export type LogInput = z.input<typeof logInput>;

export const usageResponse = z.strictObject({
  /** The account's date now, in its time zone. */
  quotaDay: z.iso.date(),
  cap: z.int(),
  /** The highest cap the account may be given, LINKEDIN_DAILY_READ_CAP_MAX. */
  capMax: z.int(),
  reserved: z.int(),
  committed: z.int(),
  windowOpen: z.boolean(),
  /** The next start of the working hours after now. */
  nextWindowAt: z.iso.datetime(),
});
export type UsageResponse = z.infer<typeof usageResponse>;

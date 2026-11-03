// The module's keyed hash (docs/security.md "The keyed hash"): HMAC-SHA-256 under LINKEDIN_HASH_KEY,
// in hex, as contacts' HASH_SALT keys a person's. Of an account's own LinkedIn member id, so that one
// LinkedIn account sits on one connected row in every workspace (domain/disclosure/member.ts), and of
// a provider event's key, the receipt that stops a redelivery (domain/receiver/). The input names its
// kind, `linkedin:<member id>` or `event:<adapter>:<key>`, so two kinds never share a hash. Without
// the key no hash can be matched to a member id, however guessable; the value itself is never kept.
import { createHmac } from "node:crypto";
import { linkedinConfig } from "../config.ts";

const MEMBER_PREFIX = "linkedin:";
const EVENT_PREFIX = "event:";
let fixed: string | null | undefined;

/** For tests (testing/): a key in place of LINKEDIN_HASH_KEY, never a real one; null: none set. */
export function useHashKey(key: string | null | undefined): void {
  fixed = key;
}

/** The key, or undefined while LINKEDIN_HASH_KEY is empty. */
function hashKey(): string | undefined {
  return fixed === undefined ? linkedinConfig.LINKEDIN_HASH_KEY : (fixed ?? undefined);
}

/** Whether LINKEDIN_HASH_KEY is set: without it no stored hash counts as a known member id. */
export const hasHashKey = (): boolean => hashKey() !== undefined;

function keyed(input: string): string | null {
  const key = hashKey();
  return key === undefined ? null : createHmac("sha256", key).update(input).digest("hex");
}

/** The hash of an account's own LinkedIn member id; null without the key. */
export const memberHash = (memberRef: string): string | null =>
  keyed(`${MEMBER_PREFIX}${memberRef}`);

/** The hash of a provider event's key at the adapter; null without the key. */
export const eventKeyHash = (adapter: string, eventKey: string): string | null =>
  keyed(`${EVENT_PREFIX}${adapter}:${eventKey}`);

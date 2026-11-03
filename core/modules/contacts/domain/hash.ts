// The salted hash (docs/concepts.md "Hash"): a rejected candidate or an erased person is kept as the
// HMAC-SHA-256 of its normalized LinkedIn URL or provider id, keyed by HASH_SALT, in hex. The input
// names its kind, `url:<url>`, `pid:<id>` or, for a suppression entry's company domain (beta-p2-010),
// `domain:<domain>`, so two kinds never share a hash, and erased hashes, kept for good, never need a
// new format. One value always gives one hash, and without the salt no hash can be matched to a URL,
// however guessable.
import { createHmac } from "node:crypto";
import { AppError } from "@whytide/platform";
import { contactsConfig } from "../config.ts";
import { errors } from "../errors.ts";

export type HashKind = "rejected_candidate" | "erased";
/**
 * What a hash is of: a normalized LinkedIn URL (a profile, or a company page), a provider's member
 * id, or a company's normalized domain.
 */
export type HashedValue = "url" | "pid" | "domain";
export type DropReasons = Readonly<Record<string, number>>;
/** A rejected candidate's hash lives this long; an erased person's forever. */
export const REJECTED_DAYS = 90;
const DAY_MS = 86_400_000;
let fixed: string | undefined;

/** For tests (testing/): a salt in place of HASH_SALT, never a real one. */
export function useSalt(salt: string | undefined): void {
  fixed = salt;
}

/** The hash of a normalized URL or provider id, `of` its kind; hash_salt_missing with no salt. */
export function hashOf(of: HashedValue, normalized: string): string {
  const salt = fixed ?? contactsConfig.HASH_SALT;
  if (salt === undefined) {
    throw new AppError(errors.hash_salt_missing, { details: { variable: "HASH_SALT" } });
  }
  return createHmac("sha256", salt).update(`${of}:${normalized}`).digest("hex");
}

/** A provider's member id as it is hashed: trimmed, 256 characters at most; null when empty. */
export function normalizeProviderId(id: string): string | null {
  const trimmed = typeof id === "string" ? id.trim() : "";
  return trimmed === "" || trimmed.length > 256 ? null : trimmed;
}

/** A hash row's state: what the rule below reads and writes. */
export type HashState = {
  readonly kind: HashKind;
  readonly dropReasons: DropReasons;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
};

/**
 * The row after a new record of `kind` meets the stored one at `now`. An expired row counts as none.
 * Erased wins over a rejected candidate and never expires; a rejected candidate expires 90 days after
 * its first record, which a later rejection does not move. The drop reasons add up as counts.
 */
export function nextHash(
  stored: HashState | null,
  kind: HashKind,
  reasons: readonly string[],
  now: Date,
): HashState {
  const live =
    stored !== null && (stored.expiresAt === null || stored.expiresAt > now) ? stored : null;
  const next = live?.kind === "erased" || kind === "erased" ? "erased" : "rejected_candidate";
  const dropReasons: Record<string, number> = { ...live?.dropReasons };
  for (const reason of reasons) dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
  const createdAt = live?.createdAt ?? now;
  const expiresAt =
    next === "erased"
      ? null
      : (live?.expiresAt ?? new Date(now.getTime() + REJECTED_DAYS * DAY_MS));
  return { kind: next, dropReasons, createdAt, expiresAt };
}

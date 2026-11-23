// The address patterns (README "The sources reply, website and pattern"; gamma-en-085): a pattern
// applied to a lead's cleaned names, and the pattern an address's local part fits; a domain's known
// patterns in the order they are guessed, and the pattern a kept address counts for (gamma-rf-030).
// Pure.

import { domainOf } from "../lookup/key.ts";
import { PATTERNS, type Pattern } from "./constants.ts";
import { type Names, namesOf } from "./names.ts";

const RENDER: Readonly<Record<Pattern, (names: Names) => string>> = {
  "{first}.{last}": ({ first, last }) => `${first}.${last}`,
  "{first}": ({ first }) => first,
  "{f}{last}": ({ first, last }) => `${first[0]}${last}`,
  "{first}{last}": ({ first, last }) => `${first}${last}`,
  "{f}.{last}": ({ first, last }) => `${first[0]}.${last}`,
  "{first}_{last}": ({ first, last }) => `${first}_${last}`,
  "{last}": ({ last }) => last,
  "{first}-{last}": ({ first, last }) => `${first}-${last}`,
  "{last}.{first}": ({ first, last }) => `${last}.${first}`,
  "{first}{l}": ({ first, last }) => `${first}${last[0]}`,
};

/** Whether the text is one of the fixed pattern names. */
export const isPattern = (text: string | null | undefined): text is Pattern =>
  (PATTERNS as readonly string[]).includes(text ?? "");

/** The local part a pattern makes of the names; null without both names. */
export function applyPattern(pattern: Pattern, names: Names): string | null {
  if (names.first === "" || names.last === "") return null;
  return RENDER[pattern](names);
}

/** The first pattern, in PATTERNS' order, that makes this local part of the names; null for none. */
export function patternOf(local: string, names: Names): Pattern | null {
  const lower = local.toLowerCase();
  return PATTERNS.find((pattern) => applyPattern(pattern, names) === lower) ?? null;
}

/** The pattern of a person's address, read from its local part and their raw names; null for none. */
export function patternOfAddress(address: string, firstName: string, lastName: string) {
  return patternOf(address.slice(0, address.lastIndexOf("@")), namesOf(firstName, lastName));
}

/** A domain's pattern as stored: how many verified addresses fitted it, when last, when seen. */
export type KnownPattern = {
  readonly pattern: string;
  readonly verifiedCount: number;
  readonly lastVerifiedAt: Date | null;
  readonly siteSeenAt: Date | null;
};

const time = (at: Date | null) => at?.getTime() ?? Number.NEGATIVE_INFINITY;

/**
 * A domain's known patterns in the order they are guessed: the higher count, then the later
 * verification, then the later sighting on the site, then PATTERNS' order. A name off the list is
 * dropped.
 */
export function rankPatterns(rows: readonly KnownPattern[]): Pattern[] {
  const known = rows.filter((row): row is KnownPattern & { pattern: Pattern } =>
    isPattern(row.pattern),
  );
  return known
    .sort(
      (a, b) =>
        b.verifiedCount - a.verifiedCount ||
        time(b.lastVerifiedAt) - time(a.lastVerifiedAt) ||
        time(b.siteSeenAt) - time(a.siteSeenAt) ||
        PATTERNS.indexOf(a.pattern) - PATTERNS.indexOf(b.pattern),
    )
    .map(({ pattern }) => pattern);
}

/**
 * The pattern a lookup's kept address counts for: a work address the lookup made a new contact point
 * of (`created`), at the company's own domain, never a subdomain, whose local part fits a pattern of
 * the person's names. An address renewed on its holder or re-verified counts nothing: null.
 */
export function countedPattern(
  kept: { readonly address: string; readonly kind: string; readonly created: boolean },
  domain: string,
  firstName: string,
  lastName: string,
): Pattern | null {
  const { address, kind, created } = kept;
  if (!created || kind !== "work_email" || domain === "" || domainOf(address) !== domain)
    return null;
  return patternOfAddress(address, firstName, lastName);
}

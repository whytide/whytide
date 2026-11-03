// The never-contact list's matching (docs/concepts.md "Suppression entry"; docs/security.md), pure:
// what an entry is written on, the hashes a person is matched by, and the answer. The match reads
// hashes only, never a raw value, so an entry still matches once erasure has emptied it.
import { hashOf } from "../hash.ts";
import {
  normalizeCompanyLinkedinUrl,
  normalizeDomain,
  normalizeLinkedinUrl,
} from "../linkedin-url.ts";
import {
  DAY_MS,
  LINKEDIN_DOMAIN,
  MIN_DOMAIN_LABELS,
  RECENT_TOUCH_DAYS,
  type SuppressionLayer,
  type SuppressionReason,
} from "./constants.ts";

/** What an entry is written on: its match type, the raw value in that type's column, the hash. */
export type EntryTarget =
  | {
      readonly matchType: "linkedin_url";
      readonly linkedinUrl: string;
      readonly domain: null;
      readonly hash: string;
    }
  | {
      readonly matchType: "domain";
      readonly linkedinUrl: null;
      readonly domain: string;
      readonly hash: string;
    };

/** The check's answer: outreach allowed, or refused and why. */
export type Suppression =
  | { readonly suppressed: false }
  | { readonly suppressed: true; readonly reason: SuppressionReason };

/** A company as the match reads it: its domain and its LinkedIn page, either may be missing. */
export type CompanyKeys = { readonly domain: string | null; readonly linkedinUrl: string | null };

/** A person's entry, on the profile URL normalized; null for a value that is no profile. */
export function personTarget(url: string): EntryTarget | null {
  const linkedinUrl = normalizeLinkedinUrl(url);
  if (linkedinUrl === null) return null;
  return { matchType: "linkedin_url", linkedinUrl, domain: null, hash: hashOf("url", linkedinUrl) };
}

/**
 * A company's entry typed as a value: a company page, else a domain of MIN_DOMAIN_LABELS labels or
 * more; null for anything else, a LinkedIn URL that is no company page included.
 */
export function companyValueTarget(value: string): EntryTarget | null {
  const page = pageTarget(value);
  if (page !== null) return page;
  const domain = normalizeDomain(value);
  if (domain === null || domain.split(".").length < MIN_DOMAIN_LABELS) return null;
  if (domain === LINKEDIN_DOMAIN || domain.endsWith(`.${LINKEDIN_DOMAIN}`)) return null;
  return domainTarget(domain);
}

/** A company's entry from its record: its domain, else its page; null with neither. */
export function companyTarget(company: CompanyKeys): EntryTarget | null {
  const domain = company.domain === null ? null : normalizeDomain(company.domain);
  if (domain !== null) return domainTarget(domain);
  return company.linkedinUrl === null ? null : pageTarget(company.linkedinUrl);
}

/** The hash a person's entries are matched by: the profile URL's. */
export function profileHash(linkedinUrl: string): string {
  return hashOf("url", normalizeLinkedinUrl(linkedinUrl) ?? linkedinUrl);
}

/**
 * The hashes a company's entries are matched by: its domain and each parent of it with
 * MIN_DOMAIN_LABELS labels or more, so that an entry on a domain holds for its subdomains, and its
 * page.
 */
export function companyHashes(company: CompanyKeys): string[] {
  const domain = company.domain === null ? null : normalizeDomain(company.domain);
  const page =
    company.linkedinUrl === null ? null : normalizeCompanyLinkedinUrl(company.linkedinUrl);
  const domains = domain === null ? [] : domainAndParents(domain);
  const pages = page === null ? [] : [hashOf("url", page)];
  return [...domains.map((name) => hashOf("domain", name)), ...pages];
}

/** The domain and each parent of it with MIN_DOMAIN_LABELS labels or more: eu.acme.com, acme.com. */
export function domainAndParents(domain: string): string[] {
  const labels = domain.split(".");
  const count = Math.max(labels.length - MIN_DOMAIN_LABELS + 1, 0);
  return Array.from({ length: count }, (_, start) => labels.slice(start).join("."));
}

/** An entry as the answer reads it. */
export type MatchedEntry = { readonly layer: SuppressionLayer; readonly hash: string };

/**
 * The answer for a person, from the entries that hold the hash of their profile or of their
 * company, and, for a new enrollment, their last touch. The first reason that applies wins:
 * opted_out, never_contact_person, never_contact_company, then recently_contacted, a touch less than
 * RECENT_TOUCH_DAYS before `now` (or after it).
 */
export function decide(input: {
  readonly entries: readonly MatchedEntry[];
  readonly profileHash: string;
  readonly companyHashes: readonly string[];
  readonly lastTouchAt: Date | null;
  readonly newEnrollment: boolean;
  readonly now: Date;
}): Suppression {
  const company = new Set(input.companyHashes);
  const own = input.entries.filter(({ hash }) => hash === input.profileHash || company.has(hash));
  if (own.some(({ layer }) => layer === "opt_out")) return refused("opted_out");
  if (own.some(({ hash }) => hash === input.profileHash)) return refused("never_contact_person");
  if (own.length > 0) return refused("never_contact_company");
  const touched = input.lastTouchAt?.getTime();
  const recent =
    touched !== undefined && input.now.getTime() - touched < RECENT_TOUCH_DAYS * DAY_MS;
  return input.newEnrollment && recent ? refused("recently_contacted") : { suppressed: false };
}

function refused(reason: SuppressionReason): Suppression {
  return { suppressed: true, reason };
}

function pageTarget(value: string): EntryTarget | null {
  const linkedinUrl = normalizeCompanyLinkedinUrl(value);
  if (linkedinUrl === null) return null;
  return { matchType: "linkedin_url", linkedinUrl, domain: null, hash: hashOf("url", linkedinUrl) };
}

function domainTarget(domain: string): EntryTarget {
  return { matchType: "domain", linkedinUrl: null, domain, hash: hashOf("domain", domain) };
}

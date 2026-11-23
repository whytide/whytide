// The never-contact list's matching (docs/concepts.md "Suppression entry"; docs/security.md), pure:
// what an entry is written on, the hashes a person is matched by (their profile's, each of their
// email addresses' since gamma-rf-040, their company's), and the answer, on a channel or with none
// (gamma-p2-040). The match reads hashes only, never a raw value, so an entry still matches once
// erasure has emptied it.
import { touchSettings } from "../../settings.ts";
import { hashOf } from "../hash.ts";
import {
  normalizeCompanyLinkedinUrl,
  normalizeDomain,
  normalizeLinkedinUrl,
} from "../linkedin-url.ts";
import {
  DAY_MS,
  EVERY_CHANNEL,
  LINKEDIN_DOMAIN,
  MIN_DOMAIN_LABELS,
  type SuppressionChannel,
  type SuppressionLayer,
  type SuppressionReason,
} from "./constants.ts";

/**
 * What an entry is written on: its match type, the raw value in that type's column, the hash. An
 * email entry's comes from emails.ts (emailTarget), or, for a person without a profile added by
 * their id or opting out, from the hash of one of their addresses, with no address (addressTarget,
 * gamma-rf-050).
 */
export type EntryTarget =
  | {
      readonly matchType: "linkedin_url";
      readonly linkedinUrl: string;
      readonly domain: null;
      readonly email: null;
      readonly hash: string;
    }
  | {
      readonly matchType: "domain";
      readonly linkedinUrl: null;
      readonly domain: string;
      readonly email: null;
      readonly hash: string;
    }
  | {
      readonly matchType: "email";
      readonly linkedinUrl: null;
      readonly domain: null;
      /** The address a member typed; null for an entry written on a person's hash alone. */
      readonly email: string | null;
      readonly hash: string;
    };

/** The check's answer: outreach allowed, or refused and why. */
export type Suppression =
  | { readonly suppressed: false }
  | {
      readonly suppressed: true;
      readonly reason: SuppressionReason;
      /**
       * On a read with a channel only: `all` when the person is stopped on every channel (an entry on
       * every channel, person_not_found or recently_contacted decides), else the deciding entry's, the
       * read's own. A read with no channel answers as before, without it.
       */
      readonly channel?: SuppressionChannel;
    };

/** A company as the match reads it: its domain and its LinkedIn page, either may be missing. */
export type CompanyKeys = { readonly domain: string | null; readonly linkedinUrl: string | null };

/** A person's entry, on the profile URL normalized; null for a value that is no profile. */
export function personTarget(url: string): EntryTarget | null {
  const linkedinUrl = normalizeLinkedinUrl(url);
  if (linkedinUrl === null) return null;
  const hash = hashOf("url", linkedinUrl);
  return { matchType: "linkedin_url", linkedinUrl, domain: null, email: null, hash };
}

/**
 * An entry on the hash of one of a person's addresses (person_email_hashes), with no address: how a
 * person without a profile is added by their id or opts out (gamma-rf-050).
 */
export function addressTarget(hash: string): EntryTarget {
  return { matchType: "email", linkedinUrl: null, domain: null, email: null, hash };
}

/**
 * A company's entry typed as a value: a company page, else a domain of MIN_DOMAIN_LABELS labels or
 * more; null for anything else, a LinkedIn URL that is no company page included.
 */
export function companyValueTarget(value: string): EntryTarget | null {
  const page = pageTarget(value);
  if (page !== null) return page;
  const domain = companyDomain(value);
  return domain === null ? null : domainTarget(domain);
}

/**
 * A value as a company's domain, normalized: MIN_DOMAIN_LABELS labels or more, never linkedin.com
 * or one of its subdomains; null for anything else.
 */
export function companyDomain(value: string): string | null {
  const domain = normalizeDomain(value);
  if (domain === null || domain.split(".").length < MIN_DOMAIN_LABELS) return null;
  if (domain === LINKEDIN_DOMAIN || domain.endsWith(`.${LINKEDIN_DOMAIN}`)) return null;
  return domain;
}

/** A company's entry from its record: its domain, else its page; null with neither. */
export function companyTarget(company: CompanyKeys): EntryTarget | null {
  const domain = company.domain === null ? null : normalizeDomain(company.domain);
  if (domain !== null) return domainTarget(domain);
  return company.linkedinUrl === null ? null : pageTarget(company.linkedinUrl);
}

/**
 * The hash a person's entries are matched by: the profile URL's. A person without a profile has
 * none, and is matched by their addresses' (gamma-rf-050).
 */
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
export type MatchedEntry = {
  readonly layer: SuppressionLayer;
  readonly hash: string;
  readonly channel: SuppressionChannel;
};

/**
 * The answer for a person, from the entries that hold the hash of their profile, of one of their
 * email addresses (`personHashes`, the person's own) or of their company, and, for a new enrollment,
 * their last touch. With `channel`, the entries on that channel
 * and those on every channel count; with none, every entry counts, the strictest answer. The stops
 * on every channel decide first, so that a refusal on `all` says the person is stopped everywhere:
 * opted_out, never_contact_person, never_contact_company, then recently_contacted, a touch less than
 * CONTACTS_RECENT_TOUCH_DAYS (settings.ts) before `now` (or after it); then never_contact_person and never_contact_company
 * on an entry for one channel. A relationship entry is a company's (never_contact_company); an entry
 * on one of the person's own hashes is theirs (opted_out or never_contact_person).
 */
export function decide(input: {
  readonly entries: readonly MatchedEntry[];
  readonly personHashes: readonly string[];
  readonly companyHashes: readonly string[];
  readonly lastTouchAt: Date | null;
  readonly newEnrollment: boolean;
  readonly now: Date;
  readonly channel?: SuppressionChannel;
}): Suppression {
  const { channel } = input;
  const person = new Set(input.personHashes);
  const company = new Set(input.companyHashes);
  const own = input.entries.filter(
    (entry) =>
      (person.has(entry.hash) || company.has(entry.hash)) && counts(entry.channel, channel),
  );
  const everywhere = own.filter((entry) => entry.channel === EVERY_CHANNEL);
  const first = firstStop(everywhere, person);
  if (first !== undefined) return refused(first.reason, first.channel, channel);
  const touched = input.lastTouchAt?.getTime();
  const days = touchSettings.CONTACTS_RECENT_TOUCH_DAYS;
  const recent = touched !== undefined && input.now.getTime() - touched < days * DAY_MS;
  if (input.newEnrollment && recent) return refused("recently_contacted", EVERY_CHANNEL, channel);
  const one = firstStop(own, person);
  return one === undefined ? { suppressed: false } : refused(one.reason, one.channel, channel);
}

/** The answer of a person the check does not know, as a read on `asked` gives it. */
export function notFound(asked: SuppressionChannel | undefined): Suppression {
  return refused("person_not_found", EVERY_CHANNEL, asked);
}

/** Whether an entry on `channel` counts for a read on `asked`: its own channel, every one, or none asked. */
function counts(channel: SuppressionChannel, asked: SuppressionChannel | undefined): boolean {
  return asked === undefined || channel === EVERY_CHANNEL || channel === asked;
}

/**
 * The first of the entries' reasons, opted_out, then the person's own (on one of `person`, their
 * hashes), then a company's, and its entry's channel.
 */
function firstStop(entries: readonly MatchedEntry[], person: ReadonlySet<string>) {
  const deciding =
    entries.find(({ layer }) => layer === "opt_out") ??
    entries.find(({ hash }) => person.has(hash)) ??
    entries[0];
  if (deciding === undefined) return undefined;
  const reason: SuppressionReason =
    deciding.layer === "opt_out"
      ? "opted_out"
      : person.has(deciding.hash)
        ? "never_contact_person"
        : "never_contact_company";
  return { reason, channel: deciding.channel };
}

/** A refusal as a read on `asked` answers it: the channel only when one was asked. */
function refused(
  reason: SuppressionReason,
  channel: SuppressionChannel,
  asked: SuppressionChannel | undefined,
): Suppression {
  return asked === undefined ? { suppressed: true, reason } : { suppressed: true, reason, channel };
}

function pageTarget(value: string): EntryTarget | null {
  const linkedinUrl = normalizeCompanyLinkedinUrl(value);
  if (linkedinUrl === null) return null;
  const hash = hashOf("url", linkedinUrl);
  return { matchType: "linkedin_url", linkedinUrl, domain: null, email: null, hash };
}

/** A domain entry on the normalized domain. */
export function domainTarget(domain: string): EntryTarget {
  const hash = hashOf("domain", domain);
  return { matchType: "domain", linkedinUrl: null, domain, email: null, hash };
}

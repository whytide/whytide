// The lookup's pure rules (docs/flows.md "The lookup"): the cache key of a person, a company domain
// as the lookup reads it, whether a candidate's address sits at the company's domain, and whether a
// personal address needs the person's consent (the owner's decision of 2026-11-13).
import { createHash } from "node:crypto";
import { CONSENT_COUNTRIES, COUNTRY_CODE, type ContactKind } from "./constants.ts";

const MARKS = /\p{M}/gu;
const SPACES = /\s+/g;
const WWW = /^www\./;

/** A name lower case, its accents folded and its spaces collapsed. */
export const normalName = (name: string): string =>
  name.normalize("NFKD").replace(MARKS, "").toLowerCase().replace(SPACES, " ").trim();

/** A company domain lower case, without `www.` and a trailing dot; empty for none. */
export const normalDomain = (domain: string | null | undefined): string =>
  (domain ?? "").trim().toLowerCase().replace(/\.$/, "").replace(WWW, "");

/** The cache key: the SHA-256 of the normalized first name, last name and company domain. */
export function keyHashOf(firstName: string, lastName: string, domain: string): string {
  const parts = [normalName(firstName), normalName(lastName), normalDomain(domain)];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** The domain of an address, lower case. */
export const domainOf = (address: string): string =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** At the company's domain or one of its subdomains. */
export function atDomain(address: string, companyDomain: string): boolean {
  const domain = domainOf(address);
  const company = normalDomain(companyDomain);
  return company !== "" && (domain === company || domain.endsWith(`.${company}`));
}

/** A work address at the company's domain, any other a personal one. */
export const kindOf = (address: string, companyDomain: string): ContactKind =>
  atDomain(address, companyDomain) ? "work_email" : "personal_email";

/**
 * Whether a personal address of a person in that country waits for consent: while the switch is
 * off, in the UK, the EU and the EEA, and with no known country.
 */
export function needsConsent(country: string | null, personalEuUk: boolean): boolean {
  if (personalEuUk) return false;
  return country === null || !COUNTRY_CODE.test(country) || CONSENT_COUNTRIES.has(country);
}

// The page-reading agent's gates, in code (agents/research-read-page/README.md "Gates"; gamma-wr-046):
// each reads the model's answer against the page that was read and refuses a part of it, never the
// whole: a company whose name is not on the page, a link that is not one of the page's links (or is no
// company's site: a social network, a directory), a place that is not on the page, a quote (and the
// line it supports) that is not on the page or holds an email address, a link or a phone number, a
// company twice on a page and a second company on a company's own site. The rest of the answer is kept.
// The gates change nothing but what they refuse and count each refusal by the gate's name, never its
// text. Nothing about a person is in the output's shape; a quote or a line that holds contact data is
// refused besides. Pure.
import { isNotAHomepage } from "@whytide/enrichment";
import type { ResearchReadOutput } from "../../schemas/research-read-page.ts";
import { holdsContact, squeeze } from "./checks.ts";
import { QUOTE_MIN_CHARS, type ReadGate } from "./constants.ts";
import { neverFetched } from "./pages.ts";

/** What the gates read of the page: its two addresses, its title and text, and every link it holds. */
export type ReadPageFacts = {
  /** The address that was asked, and the one it ended on. */
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly text: string;
  readonly links: readonly string[];
};

/** A company the page names, as the candidate step takes it. */
export type GatedCompany = {
  readonly name: string;
  /** The company's site's host, lower case, without `www.`; null when the page gives none. */
  readonly domain: string | null;
  readonly place: string | null;
  readonly line: string | null;
  readonly quote: string | null;
};
export type GatedRead = {
  readonly is: ResearchReadOutput["is"];
  readonly companies: readonly GatedCompany[];
  /** What each gate refused, by gate, only those that refused something. */
  readonly refused: Readonly<Partial<Record<ReadGate, number>>>;
};

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;
const NUMERIC_TLD = /\.\d+$/u;
const WWW = /^www\./u;

/** A text folded for comparison: compatibility forms, case and whitespace. */
export const fold = (text: string): string => squeeze(text).toLowerCase();

/** An address as links are compared: http or https, its host lower case, no fragment, no end slash. */
function linkKey(address: string): string | null {
  const url = URL.parse(address.trim());
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  if (url.username !== "" || url.password !== "") return null;
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}

/**
 * The site an address is a company's, as a host: lower case, without `www.`; null for an address that
 * is no site (a scheme but http and https, a user, an IP literal, a host that is no domain), a host the
 * run never fetches (LinkedIn, a social network) or one that is no company's homepage (a directory, a
 * news or a job site: enrichment's `isNotAHomepage`).
 */
export function siteDomainOf(address: string): string | null {
  const url = URL.parse(address.trim());
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/u, "").replace(WWW, "");
  if (!HOST.test(host) || NUMERIC_TLD.test(host)) return null;
  return neverFetched(host) || isNotAHomepage(host) ? null : host;
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);

/**
 * Whether two hosts are one site: the same host, one a subdomain of the other, or two subdomains of one
 * registrable domain. With no public-suffix list, a two-letter country code under a second level such as
 * `co` or `com` (`a.co.uk`) is read as a public suffix, never as a shared domain.
 */
export function sameSite(a: string, b: string): boolean {
  if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  const left = a.split(".");
  const right = b.split(".");
  let shared = 0;
  while (
    shared < left.length &&
    shared < right.length &&
    left[left.length - 1 - shared] === right[right.length - 1 - shared]
  )
    shared += 1;
  if (shared < 2) return false;
  const tld = left[left.length - 1] ?? "";
  const second = left[left.length - 2] ?? "";
  return !(shared === 2 && tld.length === 2 && SECOND_LEVEL.has(second));
}

/** The model's answer gated against the page. */
export function gateRead(output: ResearchReadOutput, page: ReadPageFacts): GatedRead {
  const refused: Partial<Record<ReadGate, number>> = {};
  const refuse = (gate: ReadGate) => {
    refused[gate] = (refused[gate] ?? 0) + 1;
  };
  if (output.is === "other") return { is: "other", companies: [], refused };
  const body = fold(`${page.title}\n${page.text}`);
  const links = new Set(
    [...page.links, page.url, page.finalUrl].flatMap((address) => linkKey(address) ?? []),
  );
  const own = output.is === "company_site";
  const pageHosts = [page.url, page.finalUrl].flatMap((address) => siteDomainOf(address) ?? []);
  const companies: GatedCompany[] = [];
  const seen = new Set<string>();
  for (const company of output.companies) {
    const name = squeeze(company.name);
    if (name === "" || !body.includes(fold(name))) {
      refuse("name");
      continue;
    }
    if (name.includes("@")) {
      refuse("contact");
      continue;
    }
    if (seen.has(fold(name))) {
      refuse("duplicate");
      continue;
    }
    if (own && companies.length > 0) {
      refuse("extra");
      continue;
    }
    seen.add(fold(name));
    // A company's own site is the page's own address; a listed company's, a link the page holds.
    let domain: string | null = null;
    if (own) {
      domain = siteDomainOf(page.finalUrl);
    } else if (company.link !== null) {
      const key = linkKey(company.link);
      domain = key !== null && links.has(key) ? siteDomainOf(company.link) : null;
      // A link onto the list page's own site (a member's profile on the directory) is the directory's,
      // never the company's: the company is found by its name.
      if (domain !== null && pageHosts.some((host) => sameSite(host, domain as string)))
        domain = null;
      if (domain === null) refuse("link");
    }
    let place = company.place === null ? null : squeeze(company.place);
    if (place !== null && (place === "" || !body.includes(fold(place)) || holdsContact(place))) {
      if (place !== "") refuse("place");
      place = null;
    }
    let { line, quote } = company;
    line = line === null ? null : squeeze(line);
    quote = quote === null ? null : squeeze(quote);
    if (line !== null || quote !== null) {
      if (holdsContact(line ?? "") || holdsContact(quote ?? "")) {
        refuse("contact");
        line = quote = null;
      } else if (
        line === null ||
        line === "" ||
        quote === null ||
        [...quote].length < QUOTE_MIN_CHARS ||
        !body.includes(fold(quote))
      ) {
        refuse("quote");
        line = quote = null;
      }
    }
    companies.push({ name, domain, place, line, quote });
  }
  return { is: output.is, companies, refused };
}

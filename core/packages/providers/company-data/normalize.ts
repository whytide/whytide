// One way to read a vendor's company in the port's words (README.md "Adapters"), shared by the
// adapters: a name normalized, so that "Copper Harbor Labs Ltd." and "COPPER HARBOR LABS LIMITED" are
// one name and "Copper Harbor" another; a website's host kept as the port keeps a domain; a LinkedIn
// link as the port's company page; a country's English name as its ISO 3166-1 alpha-2 code; a text
// cut to the port's bound; a count from its least. Each answers undefined for a value off its form, so
// that an adapter leaves that fact out rather than fail the lookup: the port checks its outputs in
// every environment. An adapter answers for a name only when it equals the input's once normalized.
import {
  COMBINING_MARKS,
  COMPANY_DOMAIN,
  COMPANY_LINK,
  COMPANY_PAGE,
  COMPANY_SEGMENT,
  COUNTRY_ALIASES,
  COUNTRY_LETTERS,
  DEFAULT_SCHEME,
  DOMAIN_MAX,
  HAS_SCHEME,
  HIGH_SURROGATE_END,
  LEGAL_SUFFIXES,
  LINKEDIN_HOST,
  NAME_JOINERS,
  NAME_SEPARATORS,
  NOT_COUNTRIES,
  WEB_SCHEMES,
  WWW,
} from "./constants.ts";
import type { CompanyFacts } from "./port.ts";

let countries: ReadonlyMap<string, string> | undefined;

/**
 * Lower case, accents folded, punctuation dropped, the legal forms at the end dropped, spaces
 * collapsed. A name that is only a legal form keeps it, so that it never normalizes to nothing.
 */
export function normalizeCompanyName(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(NAME_JOINERS, "")
    .split(NAME_SEPARATORS)
    .filter((word) => word !== "");
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1) ?? "")) words.pop();
  return words.join(" ");
}

/**
 * A website's host as the port keeps a domain, lower case, without `www.`; undefined for anything
 * else. The link carries its http or https scheme, unless `bareHost`: then a host given without one,
 * `example.com` or `www.example.com/about` as Diffbot and People Data Labs give a website, is read
 * as https.
 */
export function domainOf(website: unknown, { bareHost = false } = {}): string | undefined {
  const url = webUrl(website, bareHost);
  if (url === undefined) return undefined;
  const host = url.hostname.startsWith(WWW) ? url.hostname.slice(WWW.length) : url.hostname;
  return host.length <= DOMAIN_MAX && COMPANY_DOMAIN.test(host) ? host : undefined;
}

/**
 * A link to a company's LinkedIn page, with or without its scheme, on any LinkedIn host
 * (`uk.linkedin.com/company/example/about`), in the port's one form; any other page undefined.
 */
export function companyPageOf(value: unknown): string | undefined {
  const url = webUrl(value, true);
  if (url === undefined) return undefined;
  const { hostname } = url;
  if (hostname !== LINKEDIN_HOST && !hostname.endsWith(`.${LINKEDIN_HOST}`)) return undefined;
  const [segment, slug] = url.pathname.split("/").filter((part) => part !== "");
  if (segment !== COMPANY_SEGMENT || slug === undefined) return undefined;
  const page = `${COMPANY_LINK}${slug}`;
  return COMPANY_PAGE.test(page) ? page : undefined;
}

/** A country's English name, in any case, as its alpha-2 code. */
export function countryOf(value: unknown): string | undefined {
  return typeof value === "string" ? countryNames().get(nameKey(value)) : undefined;
}

/**
 * A text trimmed and cut to `max` UTF-16 units, never inside a surrogate pair; undefined when it is
 * empty or no text.
 */
export function cutText(text: unknown, max: number): string | undefined {
  if (typeof text !== "string") return undefined;
  let cut = text.trim().slice(0, max);
  if (HIGH_SURROGATE_END.test(cut)) cut = cut.slice(0, -1);
  cut = cut.trimEnd();
  return cut === "" ? undefined : cut;
}

/** An integer of at least `min`. */
export function countOf(value: unknown, min: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= min ? (value as number) : undefined;
}

/** The one value of `values` once the undefined are left out, or undefined when none or several. */
export function single<T>(values: readonly (T | undefined)[]): T | undefined {
  const distinct = new Set(values.filter((value) => value !== undefined));
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

/** The facts an adapter knows, those left undefined dropped; undefined when it knows none. */
export function knownFacts(
  facts: { readonly [K in keyof CompanyFacts]: CompanyFacts[K] | undefined },
): CompanyFacts | undefined {
  const known = Object.entries(facts).filter(([, value]) => value !== undefined);
  return known.length === 0 ? undefined : (Object.fromEntries(known) as CompanyFacts);
}

/** A link of the web; given without its scheme, read as https when `bare` allows it. */
function webUrl(value: unknown, bare: boolean): URL | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const url = URL.parse(bare && !HAS_SCHEME.test(text) ? `${DEFAULT_SCHEME}${text}` : text);
  return url !== null && WEB_SCHEMES.has(url.protocol) ? url : undefined;
}

function countryNames(): ReadonlyMap<string, string> {
  if (countries !== undefined) return countries;
  const display = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const names = new Map<string, string>();
  for (const first of COUNTRY_LETTERS) {
    for (const second of COUNTRY_LETTERS) {
      const code = `${first}${second}`;
      // A withdrawn code (DD, SU, YU) canonicalizes to its successor, which ICU names too.
      if (NOT_COUNTRIES.has(code) || Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`)
        continue;
      const name = display.of(code);
      if (name !== undefined) names.set(nameKey(name), code);
    }
  }
  for (const [name, code] of Object.entries(COUNTRY_ALIASES)) names.set(nameKey(name), code);
  countries = names;
  return names;
}

/** A name as compared: no case, accents or apostrophes; "&" as "and", "St." as "saint". */
function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bst\.?\s/g, "saint ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

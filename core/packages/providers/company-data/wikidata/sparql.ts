// The wikidata adapter's queries and what it reads of their answers (README.md "Calls", "Mapping",
// "The match rule"). A query selects at most two items by one of the company's keys, every value it
// carries in a VALUES block (a slug, a website's forms, the search's item ids, a country code, each
// checked against its form first), then reads their facts, one row per value. The rows map to the
// port's facts only for one item: two are ambiguous, and the adapter answers not_found.
import { z } from "zod";
import {
  COMPANY_LINK,
  COMPANY_PAGE,
  COUNTRY_CODE,
  DESCRIPTION_MAX,
  EMPLOYEE_COUNT_MIN,
  FOUNDED_YEAR_MAX,
  FOUNDED_YEAR_MIN,
  INDUSTRY_MAX,
} from "../constants.ts";
import { cutText, domainOf, knownFacts, normalizeCompanyName, single } from "../normalize.ts";
import type { CompanyFacts } from "../port.ts";
import {
  A_BUSINESS,
  BY_LINKEDIN,
  BY_WEBSITE,
  ENTITY,
  FACTS,
  IN_COUNTRY,
  ITEM_ID,
  ITEMS_AT_MOST,
  MAX_CANDIDATES,
  MAX_ROWS,
  ROW,
  SLUG_LITERAL,
  WEBSITE_ENDS,
  WEBSITE_PREFIXES,
  WEBSITE_SCHEMES,
  YEAR,
} from "./constants.ts";

const term = z.object({ value: z.string() });
const row = z.object({
  item: term,
  p: term,
  value: term.optional(),
  of: term.optional(),
  time: term.optional(),
});
type Row = z.infer<typeof row>;
/** The query service's JSON answer: its rows, each term's value. */
export const sparqlAnswer = z.object({
  results: z.object({ bindings: z.array(row).max(MAX_ROWS) }),
});
/** wbsearchentities' answer: each item's id, its label and the label or alias it matched. */
export const searchAnswer = z.object({
  search: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().optional(),
        match: z.object({ text: z.string().optional() }).optional(),
      }),
    )
    .max(MAX_CANDIDATES),
});

const values = (variable: string, terms: readonly string[]) =>
  `VALUES ?${variable} { ${[...new Set(terms)].join(" ")} }`;

/** The items whose LinkedIn company ID is the page's slug, as given or in lower case. */
export function byLinkedin(linkedinUrl: string): string | undefined {
  const slug = linkedinUrl.slice(COMPANY_LINK.length);
  if (!SLUG_LITERAL.test(slug)) return undefined;
  return `${values(
    "id",
    [slug, slug.toLowerCase()].map((id) => `"${id}"`),
  )} ${BY_LINKEDIN}`;
}

/** The items whose official website is at the domain: either scheme, with or without www. and a slash. */
export function byWebsite(domain: string): string {
  const sites = WEBSITE_SCHEMES.flatMap((scheme) =>
    WEBSITE_PREFIXES.flatMap((prefix) =>
      WEBSITE_ENDS.map((end) => `<${scheme}${prefix}${domain}${end}>`),
    ),
  );
  return `${values("site", sites)} ${BY_WEBSITE}`;
}

/** Of the search's items, the businesses, and with a hint those in its country. */
export function byItems(ids: readonly string[], countryHint: string | undefined): string {
  const items = `${values(
    "item",
    ids.map((id) => `wd:${id}`),
  )} ${A_BUSINESS}`;
  if (countryHint === undefined || !COUNTRY_CODE.test(countryHint)) return items;
  return `${items} ${values("country", [`"${countryHint}"`])} ${IN_COUNTRY}`;
}

/** The facts query over a selection's items, at most ITEMS_AT_MOST of them. */
export const factsQuery = (selection: string) =>
  `SELECT ?item ?p ?value ?of ?time WHERE {
  { SELECT DISTINCT ?item WHERE { ${selection} } LIMIT ${ITEMS_AT_MOST} }
  ${FACTS}
}`;

/** The search's items whose label, or the alias it matched, is the name once both are normalized. */
export function candidates(answer: z.infer<typeof searchAnswer>, name: string): string[] {
  const wanted = normalizeCompanyName(name);
  const named = (text: string | undefined) =>
    text !== undefined && normalizeCompanyName(text) === wanted;
  const ids = answer.search
    .filter(({ id, label, match }) => ITEM_ID.test(id) && (named(label) || named(match?.text)))
    .map(({ id }) => id);
  return [...new Set(ids)];
}

/** The answer's items, and the facts of the one item when there is one. */
export function itemsOf(answer: z.infer<typeof sparqlAnswer>): {
  readonly count: number;
  readonly facts: CompanyFacts | undefined;
} {
  const rows = answer.results.bindings;
  const count = new Set(rows.map((r) => r.item.value)).size;
  return { count, facts: count === 1 ? factsOf(rows) : undefined };
}

/** One item's rows as the port's facts (README.md "Mapping"); undefined when none is there. */
function factsOf(rows: readonly Row[]): CompanyFacts | undefined {
  const of = (p: string) => rows.filter((r) => r.p.value === p && r.value !== undefined);
  const texts = (p: string) => of(p).map((r) => r.value?.value ?? "");
  return knownFacts({
    domain: single(texts(ROW.website).map((website) => domainOf(website))),
    linkedinUrl: single(texts(ROW.linkedin).map(pageOf)),
    industry: industryOf(of(ROW.industry)),
    employeeCount: employeesOf(of(ROW.employees)),
    country: single(texts(ROW.country).map((code) => (COUNTRY_CODE.test(code) ? code : undefined))),
    foundedYear: foundedOf(texts(ROW.founded)),
    description: cutText(texts(ROW.description)[0] ?? "", DESCRIPTION_MAX),
  });
}

/** A LinkedIn company ID as the port's page, when it takes the page's form. */
function pageOf(id: string): string | undefined {
  const page = `${COMPANY_LINK}${id}`;
  return COMPANY_PAGE.test(page) ? page : undefined;
}

/** The first industry: the English label of the industry item with the lowest number. */
function industryOf(rows: readonly Row[]): string | undefined {
  const number = (r: Row) => Number(r.of?.value.slice(ENTITY.length).slice(1));
  const labels = rows
    .filter((r) => r.of?.value.startsWith(ENTITY) && ITEM_ID.test(r.of.value.slice(ENTITY.length)))
    .toSorted((a, b) => number(a) - number(b))
    .map((r) => cutText(r.value?.value ?? "", INDUSTRY_MAX));
  return labels.find((label) => label !== undefined);
}

/**
 * The employee count with the latest point in time; at that time, one count only. Without any point
 * in time, the one count there is, if one.
 */
function employeesOf(rows: readonly Row[]): number | undefined {
  const counts = rows
    .map((r) => ({ count: Number(r.value?.value), at: Date.parse(r.time?.value ?? "") }))
    .filter(({ count }) => Number.isSafeInteger(count) && count >= EMPLOYEE_COUNT_MIN);
  const dated = counts.filter(({ at }) => !Number.isNaN(at));
  if (dated.length === 0) return single(counts.map(({ count }) => count));
  const latest = Math.max(...dated.map(({ at }) => at));
  return single(dated.filter(({ at }) => at === latest).map(({ count }) => count));
}

/** The earliest year of P571's times, a year of the common era. */
function foundedOf(times: readonly string[]): number | undefined {
  const years = times
    .map((time) => Number(YEAR.exec(time)?.[1]))
    .filter((year) => year >= FOUNDED_YEAR_MIN && year <= FOUNDED_YEAR_MAX);
  return years.length === 0 ? undefined : Math.min(...years);
}

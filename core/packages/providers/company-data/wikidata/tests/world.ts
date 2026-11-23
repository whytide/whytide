// Wikidata's answers for the mapping tests, synthetic, in the shapes of the query service's JSON
// results and of wbsearchentities: one item with every fact of the README's mapping table, P1128 at
// several points in time, P452 twice; none; two items; an item with no fact; a search whose results
// match the name by a label and by an alias, and one that does not. The route answers a query by the
// values of its VALUES blocks and a search by its name.
import type { CompanyFacts } from "../../port.ts";
import type { Answer, Received } from "../../tests/fixtures/vendor.ts";
import { ENTITY } from "../constants.ts";

export const PAGE = "https://www.linkedin.com/company/copper-harbor-labs";
export const DOMAIN = "copper-harbor.example";
export const NAME = "Copper Harbor Labs";
/** The facts the one item's answer maps to: every row of the README's table. */
export const FACTS: CompanyFacts = {
  domain: DOMAIN,
  linkedinUrl: PAGE,
  industry: "Software development",
  employeeCount: 42,
  country: "GB",
  foundedYear: 2018,
  description: "A synthetic company of the wikidata adapter's tests",
};

const uri = (value: string) => ({ type: "uri", value });
const literal = (value: string) => ({ type: "literal", value });
const english = (value: string) => ({ "xml:lang": "en", type: "literal", value });
const dateTime = (value: string) => ({
  datatype: "http://www.w3.org/2001/XMLSchema#dateTime",
  type: "literal",
  value,
});
const decimal = (value: string) => ({
  datatype: "http://www.w3.org/2001/XMLSchema#decimal",
  type: "literal",
  value,
});
const rows = (item: string, facts: readonly Record<string, unknown>[]) =>
  [{ p: "item" }, ...facts].map(({ p, ...terms }) => ({
    item: uri(`${ENTITY}${item}`),
    p: literal(String(p)),
    ...terms,
  }));
const answer = (bindings: readonly unknown[]): Answer => ({
  headers: { "content-type": "application/sparql-results+json" },
  body: { head: { vars: ["item", "p", "value", "of", "time"] }, results: { bindings } },
});

/** One item: two websites on one host, two industries (the lower number first), P1128 four times. */
export const ONE_ITEM = answer(
  rows("Q1001", [
    { p: "P856", value: uri("https://www.copper-harbor.example/") },
    { p: "P856", value: uri("http://copper-harbor.example") },
    { p: "P4264", value: literal("copper-harbor-labs") },
    { p: "P452", value: english("Marine engineering"), of: uri(`${ENTITY}Q1048835`) },
    { p: "P452", value: english("Software development"), of: uri(`${ENTITY}Q638608`) },
    { p: "P1128", value: decimal("12"), time: dateTime("2019-12-31T00:00:00Z") },
    { p: "P1128", value: decimal("42"), time: dateTime("2024-12-31T00:00:00Z") },
    { p: "P1128", value: decimal("30"), time: dateTime("2022-12-31T00:00:00Z") },
    { p: "P1128", value: decimal("99") },
    { p: "P297", value: literal("GB") },
    { p: "P571", value: dateTime("2019-03-01T00:00:00Z") },
    { p: "P571", value: dateTime("2018-01-01T00:00:00Z") },
    { p: "description", value: english(FACTS.description ?? "") },
  ]),
);
export const NO_ITEM = answer([]);
export const TWO_ITEMS = answer([
  ...rows("Q2001", [{ p: "P297", value: literal("GB") }]),
  ...rows("Q2002", [{ p: "P297", value: literal("IE") }]),
]);
/** An item that has no fact: a label alone is not one. */
export const BARE_ITEM = answer(rows("Q3001", []));

/**
 * The search for NAME, and for any name it starts with: Q1001 by its label, Q1003 by an alias;
 * Q1002's label is another name.
 */
export const SEARCH = {
  body: {
    searchinfo: { search: NAME },
    search: [
      { id: "Q1001", label: NAME, match: { type: "label", language: "en", text: NAME } },
      { id: "Q1002", label: "Copper Harbor Logistics", match: { type: "label", text: "Copper" } },
      { id: "Q1003", label: "CHL", match: { type: "alias", text: "Copper Harbor Labs Ltd." } },
    ],
    success: 1,
  },
} satisfies Answer;

/** The tokens of each VALUES block of a query, by its variable. */
export function valuesOf(query: string): Record<string, string[]> {
  const blocks = [...query.matchAll(/VALUES \?(\w+) \{ ([^}]*) \}/g)];
  return Object.fromEntries(blocks.map(([, name, terms]) => [name, (terms ?? "").split(" ")]));
}

/** A query's text without its VALUES blocks: the template, which holds no input. */
export const templateOf = (query: string) => query.replaceAll(/VALUES \?\w+ \{ [^}]* \}/g, "");

export const queryOf = (request: Received) => new URLSearchParams(request.body).get("query") ?? "";

/** The answers by what a request asks for. */
export function route(request: Received): Answer {
  if (request.path === "/w/api.php") {
    const copper = request.query.search?.startsWith("Copper Harbor") === true;
    return copper ? SEARCH : { body: { search: [], success: 1 } };
  }
  const values = Object.values(valuesOf(queryOf(request))).flat();
  if (values.includes('"twin-harbor"')) return TWO_ITEMS;
  if (values.includes('"bare-harbor"')) return BARE_ITEM;
  const known = ['"copper-harbor-labs"', `<https://www.${DOMAIN}/>`, "wd:Q1001"];
  return values.some((value) => known.includes(value)) ? ONE_ITEM : NO_ITEM;
}

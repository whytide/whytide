// The wikidata adapter of the company-data port (README.md): open data, no key. It finds the item by
// the first of the company's keys that finds any (README.md "The match rule"): its LinkedIn company
// ID, then its official website, then its name through the search, keeping the businesses and, with
// a hint, those in its country. One item is the company; two are not_found, never a guess. Its facts
// come from one query (sparql.ts). WIKIDATA_CONTACT goes in every request's User-Agent; the requests
// of the process are a second apart (client.ts).
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { missingVariable, shaped } from "../answer.ts";
import { type CompanyLookupResult, companyDataPort } from "../port.ts";
import { type Gate, processGate, wikidataClient } from "./client.ts";
import { wikidataConfig } from "./config.ts";
import { API_URL, SPARQL_URL } from "./constants.ts";
import {
  byItems,
  byLinkedin,
  byWebsite,
  candidates,
  factsQuery,
  itemsOf,
  searchAnswer,
  sparqlAnswer,
} from "./sparql.ts";

export type WikidataOptions = {
  /** WIKIDATA_CONTACT: an email address or an https page, for the User-Agent. */
  readonly contact: string;
  /** The query service and the API; a test passes its loopback server's. */
  readonly sparqlUrl?: string;
  readonly apiUrl?: string;
  /** The process's gate unless a test passes its own. */
  readonly gate?: Gate;
  readonly now?: () => number;
};

const NOT_FOUND: CompanyLookupResult = { result: "not_found" };

export function wikidataCompanyData({
  contact,
  sparqlUrl = SPARQL_URL,
  apiUrl = API_URL,
  gate = processGate,
  now = Date.now,
}: WikidataOptions): PortImplementation<typeof companyDataPort> {
  const client = wikidataClient({ contact, sparqlUrl, apiUrl, gate, now });
  /** The selection's one item as found, two as not_found; undefined when it holds none. */
  const select = async (selection: string): Promise<CompanyLookupResult | undefined> => {
    const { count, facts } = itemsOf(
      shaped(sparqlAnswer, await client.sparql(factsQuery(selection))),
    );
    if (count === 0) return undefined;
    return facts === undefined ? NOT_FOUND : { result: "found", company: facts };
  };
  return {
    lookupCompany: async ({ linkedinUrl, domain, name, countryHint }) => {
      const byPage = linkedinUrl === undefined ? undefined : byLinkedin(linkedinUrl);
      const answer =
        (byPage === undefined ? undefined : await select(byPage)) ??
        (domain === undefined ? undefined : await select(byWebsite(domain)));
      if (answer !== undefined || name === undefined) return answer ?? NOT_FOUND;
      const ids = candidates(shaped(searchAnswer, await client.search(name)), name);
      if (ids.length === 0) return NOT_FOUND;
      return (await select(byItems(ids, countryHint))) ?? NOT_FOUND;
    },
  };
}

export const wikidataAdapter = defineAdapter(companyDataPort, {
  name: "wikidata",
  requires: ["WIKIDATA_CONTACT"],
  allowance: wikidataConfig.WIKIDATA_ALLOWANCE,
  openData: true,
  create: () => {
    const contact = wikidataConfig.WIKIDATA_CONTACT;
    if (!contact) throw missingVariable("WIKIDATA_CONTACT", "wikidata");
    return wikidataCompanyData({ contact });
  },
});

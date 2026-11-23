// The companies-house adapter of the company-data port (README.md): the UK register, a company's
// industry by its first SIC code and its country. It runs only for a hint of the United Kingdom or a
// domain under .uk, and only with a name: anything else is not_found with no call. It searches the
// name, keeps the one active company whose name is the input's once both are normalized
// (../normalize.ts), then reads its profile: none, two, or a company no longer active is not_found,
// never a guess. Open data, under the Open Government Licence (README.md "Licence").
import { z } from "zod";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { missingVariable, shaped } from "../answer.ts";
import { knownFacts, normalizeCompanyName, single } from "../normalize.ts";
import { type CompanyLookupResult, companyDataPort } from "../port.ts";
import { companiesHouseClient } from "./client.ts";
import { companiesHouseConfig } from "./config.ts";
import {
  ACTIVE,
  API_URL,
  COMPANY_NUMBER,
  MAX_ITEMS,
  MAX_SIC_CODES,
  UK_DOMAIN,
  UNITED_KINGDOM,
} from "./constants.ts";
import { SIC_2007 } from "./sic-2007.ts";

export type CompaniesHouseOptions = {
  /** COMPANIES_HOUSE_API_KEY. */
  readonly apiKey: string;
  /** The API's address; a test passes its loopback server's. */
  readonly apiUrl?: string;
  readonly now?: () => number;
};

/** The search's answer: each company's name, number and status, nothing else of it. */
const searchAnswer = z.object({
  items: z
    .array(
      z.object({
        title: z.string(),
        company_number: z.string(),
        company_status: z.string().optional(),
      }),
    )
    .max(MAX_ITEMS)
    .optional(),
});
/** A company's profile: its status and its SIC codes, nothing else of it. */
const profileAnswer = z.object({
  company_status: z.string().optional(),
  sic_codes: z.array(z.string()).max(MAX_SIC_CODES).optional(),
});

const NOT_FOUND: CompanyLookupResult = { result: "not_found" };

export function companiesHouseCompanyData({
  apiKey,
  apiUrl = API_URL,
  now = Date.now,
}: CompaniesHouseOptions): PortImplementation<typeof companyDataPort> {
  const client = companiesHouseClient(apiUrl, apiKey, now);
  return {
    lookupCompany: async ({ name, domain, countryHint }) => {
      const british = countryHint === UNITED_KINGDOM || domain?.endsWith(UK_DOMAIN) === true;
      if (!british || name === undefined) return NOT_FOUND;
      const wanted = normalizeCompanyName(name);
      const { items = [] } = shaped(searchAnswer, await client.search(name));
      const number = single(
        items.map(({ title, company_number, company_status }) =>
          company_status === ACTIVE &&
          COMPANY_NUMBER.test(company_number) &&
          normalizeCompanyName(title) === wanted
            ? company_number
            : undefined,
        ),
      );
      if (number === undefined) return NOT_FOUND;
      const profile = shaped(profileAnswer, await client.company(number));
      if (profile.company_status !== ACTIVE) return NOT_FOUND;
      const [sic] = profile.sic_codes ?? [];
      const facts = knownFacts({
        industry: sic === undefined ? undefined : SIC_2007.get(sic),
        country: UNITED_KINGDOM,
      });
      return facts === undefined ? NOT_FOUND : { result: "found", company: facts };
    },
  };
}

export const companiesHouseAdapter = defineAdapter(companyDataPort, {
  name: "companies-house",
  requires: ["COMPANIES_HOUSE_API_KEY"],
  allowance: companiesHouseConfig.COMPANIES_HOUSE_ALLOWANCE,
  openData: true,
  create: () => {
    const apiKey = companiesHouseConfig.COMPANIES_HOUSE_API_KEY;
    if (!apiKey) throw missingVariable("COMPANIES_HOUSE_API_KEY", "companies-house");
    return companiesHouseCompanyData({ apiKey });
  },
});

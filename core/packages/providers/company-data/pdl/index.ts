// The pdl adapter of the company-data port (README.md): People Data Labs' Company Enrichment, on the
// free plan's 100 a month. It sends one company key, the LinkedIn page as `profile`, else the domain
// as `website`, else the name, with `min_likelihood` from PDL_MIN_LIKELIHOOD, and maps the match
// onto CompanyFacts (README.md "Mapping"); a 404, or a match below that likelihood, is not_found.
// Its data is a vendor's, not open data. No SDK, no retry: enrichment counts the calls and retries
// by the code.
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { missingVariable, providerError } from "../answer.ts";
import {
  DESCRIPTION_MAX,
  EMPLOYEE_COUNT_MIN,
  EMPLOYEE_RANGE_MIN,
  FOUNDED_YEAR_MAX,
  FOUNDED_YEAR_MIN,
  INDUSTRY_MAX,
} from "../constants.ts";
import { companyPageOf, countOf, countryOf, cutText, domainOf, knownFacts } from "../normalize.ts";
import {
  type CompanyFacts,
  type CompanyLookup,
  type CompanyLookupResult,
  companyDataPort,
} from "../port.ts";
import { type EnrichKey, type PdlClient, pdlClient } from "./client.ts";
import { pdlConfig } from "./config.ts";
import { KEY_VARIABLE, PDL_ORIGIN, SIZE_OPEN, SIZE_RANGE, TIMEOUT_MS } from "./constants.ts";

/** The parts of a PDL company record the adapter reads; every other field is left unread. */
type Company = {
  readonly likelihood?: unknown;
  readonly industry?: unknown;
  readonly employee_count?: unknown;
  readonly size?: unknown;
  readonly website?: unknown;
  readonly linkedin_url?: unknown;
  readonly location?: { readonly country?: unknown } | null;
  readonly founded?: unknown;
  readonly summary?: unknown;
};

export type PdlOptions = {
  /** People Data Labs' fixed host; a test's server on 127.0.0.1. */
  readonly origin: string;
  readonly apiKey: string;
  readonly minLikelihood: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

const NOT_FOUND: CompanyLookupResult = { result: "not_found" };

/** The adapter on `origin` with `apiKey`: what create() returns on PDL's host. */
export function pdlCompanyData(options: PdlOptions): PortImplementation<typeof companyDataPort> {
  const { origin, apiKey, minLikelihood, timeoutMs = TIMEOUT_MS, now = Date.now } = options;
  const client: PdlClient = pdlClient(origin, apiKey, timeoutMs, now);
  return {
    lookupCompany: async (lookup) => {
      const company = companyOf(await client(keyOf(lookup), minLikelihood));
      // PDL answers 404 below min_likelihood; a weaker match that came back anyway is none either.
      if (company === undefined || countOf(company.likelihood, minLikelihood) === undefined) {
        return NOT_FOUND;
      }
      const facts = factsOfCompany(company);
      return facts === undefined ? NOT_FOUND : { result: "found", company: facts };
    },
  };
}

export const pdlAdapter = defineAdapter(companyDataPort, {
  name: "pdl",
  requires: [KEY_VARIABLE],
  allowance: pdlConfig.PDL_ALLOWANCE,
  openData: false,
  create: () => {
    const apiKey = pdlConfig.PDL_API_KEY;
    if (!apiKey) throw missingVariable(KEY_VARIABLE, "pdl");
    const minLikelihood = pdlConfig.PDL_MIN_LIKELIHOOD;
    return pdlCompanyData({ origin: PDL_ORIGIN, apiKey, minLikelihood });
  },
});

/** The one key sent: the LinkedIn page as `profile`, else the domain as `website`, else the name. */
function keyOf({ linkedinUrl, domain, name }: CompanyLookup): EnrichKey {
  if (linkedinUrl !== undefined) return { profile: linkedinUrl };
  if (domain !== undefined) return { website: domain };
  // The port's input refuses a lookup without one of the three.
  return { name: name as string };
}

/** The match's record: its fields sit at the top level of the answer. */
function companyOf(answer: unknown): Company | undefined {
  if (answer === undefined) return undefined;
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    throw providerError({ reason: "off_shape" });
  }
  return answer as Company;
}

/** The record's facts in the port's forms; undefined when it has none the port takes. */
function factsOfCompany(company: Company): CompanyFacts | undefined {
  const employeeCount = countOf(company.employee_count, EMPLOYEE_COUNT_MIN);
  const year = countOf(company.founded, FOUNDED_YEAR_MIN);
  return knownFacts({
    domain: domainOf(company.website, { bareHost: true }),
    linkedinUrl: companyPageOf(company.linkedin_url),
    industry: cutText(company.industry, INDUSTRY_MAX),
    employeeCount,
    employeeRange: employeeCount === undefined ? sizeOf(company.size) : undefined,
    country: countryOf(company.location?.country),
    description: cutText(company.summary, DESCRIPTION_MAX),
    foundedYear: year !== undefined && year <= FOUNDED_YEAR_MAX ? year : undefined,
  });
}

/** A canonical size, `11-50` or `10001+`, as a range. */
function sizeOf(size: unknown): CompanyFacts["employeeRange"] {
  if (typeof size !== "string") return undefined;
  const [, least] = SIZE_OPEN.exec(size) ?? [];
  if (least !== undefined) {
    const from = countOf(Number(least), EMPLOYEE_RANGE_MIN);
    return from === undefined ? undefined : { from };
  }
  const [, low, high] = SIZE_RANGE.exec(size) ?? [];
  const from = countOf(Number(low), EMPLOYEE_RANGE_MIN);
  const to = countOf(Number(high), Math.max(from ?? 0, EMPLOYEE_COUNT_MIN));
  return from === undefined || to === undefined ? undefined : { from, to };
}

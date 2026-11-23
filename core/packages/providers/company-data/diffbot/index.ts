// The diffbot adapter of the company-data port (README.md): Diffbot's Knowledge Graph, Enhance for an
// Organization, on the free plan's 400 matched companies a month. It sends one company key, the
// LinkedIn page, else the domain, else the name, and maps the one match at or above MIN_SCORE onto
// CompanyFacts (README.md "Mapping"); a weaker match, or none, is not_found. Its data is a vendor's,
// not open data. No SDK, no retry: enrichment counts the calls and retries by the code.
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
import { type DiffbotClient, diffbotClient, type EnhanceKey } from "./client.ts";
import { diffbotConfig } from "./config.ts";
import {
  DIFFBOT_ORIGIN,
  FOUNDING_YEAR,
  MIN_SCORE,
  TIMEOUT_MS,
  TOKEN_VARIABLE,
} from "./constants.ts";

/** The parts of Diffbot's Organization the adapter reads; every other field is left unread. */
type Organization = {
  readonly industries?: unknown;
  readonly nbEmployees?: unknown;
  readonly nbEmployeesMin?: unknown;
  readonly nbEmployeesMax?: unknown;
  readonly homepageUri?: unknown;
  readonly linkedInUri?: unknown;
  readonly location?: { readonly country?: { readonly name?: unknown } | null } | null;
  readonly foundingDate?: { readonly str?: unknown } | null;
  readonly description?: unknown;
};
type Match = { readonly score?: unknown; readonly entity?: unknown };

export type DiffbotOptions = {
  /** Diffbot's fixed host; a test's server on 127.0.0.1. */
  readonly origin: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

const NOT_FOUND: CompanyLookupResult = { result: "not_found" };

/** The adapter on `origin` with `token`: what create() returns on Diffbot's host. */
export function diffbotCompanyData(
  options: DiffbotOptions,
): PortImplementation<typeof companyDataPort> {
  const { origin, token, timeoutMs = TIMEOUT_MS, now = Date.now } = options;
  const client: DiffbotClient = diffbotClient(origin, token, timeoutMs, now);
  return {
    lookupCompany: async (lookup) => {
      const organization = matchOf(await client(keyOf(lookup), MIN_SCORE));
      const facts = organization === undefined ? undefined : factsOfOrganization(organization);
      return facts === undefined ? NOT_FOUND : { result: "found", company: facts };
    },
  };
}

export const diffbotAdapter = defineAdapter(companyDataPort, {
  name: "diffbot",
  requires: [TOKEN_VARIABLE],
  allowance: diffbotConfig.DIFFBOT_ALLOWANCE,
  openData: false,
  create: () => {
    const token = diffbotConfig.DIFFBOT_TOKEN;
    if (!token) throw missingVariable(TOKEN_VARIABLE, "diffbot");
    return diffbotCompanyData({ origin: DIFFBOT_ORIGIN, token });
  },
});

/** The one key sent: the LinkedIn page, else the domain, as `url`; else the name. */
function keyOf({ linkedinUrl, domain, name }: CompanyLookup): EnhanceKey {
  const url = linkedinUrl ?? domain;
  if (url !== undefined) return { url };
  // The port's input refuses a lookup without one of the three.
  return { name: name as string };
}

/** The best match's Organization when its score reaches MIN_SCORE; none, or a weaker one, undefined. */
function matchOf(answer: unknown): Organization | undefined {
  const data = (answer as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw providerError({ reason: "off_shape" });
  const [best] = data as Match[];
  if (best === undefined) return undefined;
  if (typeof best.score !== "number" || best.score < MIN_SCORE) return undefined;
  if (typeof best.entity !== "object" || best.entity === null) {
    throw providerError({ reason: "off_shape" });
  }
  return best.entity as Organization;
}

/** The Organization's facts in the port's forms; undefined when it has none the port takes. */
function factsOfOrganization(organization: Organization): CompanyFacts | undefined {
  const industries = Array.isArray(organization.industries) ? organization.industries : [];
  const employeeCount = countOf(organization.nbEmployees, EMPLOYEE_COUNT_MIN);
  return knownFacts({
    domain: domainOf(organization.homepageUri, { bareHost: true }),
    linkedinUrl: companyPageOf(organization.linkedInUri),
    industry: cutText(industries[0], INDUSTRY_MAX),
    employeeCount,
    employeeRange:
      employeeCount === undefined
        ? rangeOf(organization.nbEmployeesMin, organization.nbEmployeesMax)
        : undefined,
    country: countryOf(organization.location?.country?.name),
    description: cutText(organization.description, DESCRIPTION_MAX),
    foundedYear: yearOf(organization.foundingDate?.str),
  });
}

/** A range from its bounds: `{ from }` alone when there is no upper one; none when they disagree. */
function rangeOf(min: unknown, max: unknown): CompanyFacts["employeeRange"] {
  const from = countOf(min, EMPLOYEE_RANGE_MIN);
  if (from === undefined) return undefined;
  if (max === undefined || max === null) return { from };
  const to = countOf(max, Math.max(from, EMPLOYEE_COUNT_MIN));
  return to === undefined ? undefined : { from, to };
}

/** A founding date's year, from its text, `d2008-XX-XX`. */
function yearOf(text: unknown): number | undefined {
  const year = typeof text === "string" ? FOUNDING_YEAR.exec(text)?.[1] : undefined;
  const value = countOf(Number(year), FOUNDED_YEAR_MIN);
  return value !== undefined && value <= FOUNDED_YEAR_MAX ? value : undefined;
}

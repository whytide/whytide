// The company-data port (docs/architecture.md §9, docs/rules/coding.md §6; briefs RB-7.1.1 reduced,
// RB-7.3.1): a company's facts from its LinkedIn page, its domain or its name, in our words
// (README.md). One method, lookupCompany(). The input is a company's keys and nothing else, a strict
// object, so that no person's name, title or address reaches a company source; the output is the
// facts found, or not_found, strict and checked in every environment, production included. Each
// adapter declares its free allowance and whether its data is open data; enrichment counts the calls
// and asks the adapters of PROVIDER_COMPANY_DATA in its order (../README.md "Many adapters per port").
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";
import {
  COMPANY_DOMAIN,
  COMPANY_PAGE,
  COUNTRY_CODE,
  DESCRIPTION_MAX,
  DOMAIN_MAX,
  EMPLOYEE_COUNT_MIN,
  EMPLOYEE_RANGE_MIN,
  FOUNDED_YEAR_MAX,
  FOUNDED_YEAR_MIN,
  INDUSTRY_MAX,
  NAME_MAX,
  NOT_BLANK,
} from "./constants.ts";

export { companyDataConfig } from "./config.ts";
export type { CompanyDataFake } from "./fake/index.ts";

/** A company's LinkedIn page, https://www.linkedin.com/company/<slug>, in that one form. */
const companyPage = z.string().regex(COMPANY_PAGE, "https://www.linkedin.com/company/<slug>");
/** A host name, lower case, without `www.`. */
const companyDomain = z
  .string()
  .max(DOMAIN_MAX)
  .regex(COMPANY_DOMAIN, "a host name, lower case, without www.");
const companyName = z.string().min(1).max(NAME_MAX).regex(NOT_BLANK, "not blank");
const countryCode = z.string().regex(COUNTRY_CODE, "an ISO 3166-1 alpha-2 code");
/** A text fact: not empty, so that an adapter leaves out what it does not know. */
const text = (max: number) => z.string().min(1).max(max);

/** The keys a lookup takes, at least one of the three; `countryHint` narrows a name. Nothing else. */
export const companyLookup = z
  .strictObject({
    linkedinUrl: companyPage.optional(),
    domain: companyDomain.optional(),
    name: companyName.optional(),
    countryHint: countryCode.optional(),
  })
  .refine(
    ({ linkedinUrl, domain, name }) => [linkedinUrl, domain, name].some((key) => key !== undefined),
    "at least one of linkedinUrl, domain and name",
  );

/** A size band, `to` left out for an open one (10,001+). */
const employeeRange = z
  .strictObject({
    from: z.int().min(EMPLOYEE_RANGE_MIN),
    to: z.int().min(EMPLOYEE_COUNT_MIN).optional(),
  })
  .refine(({ from, to }) => to === undefined || to >= from, "`to` at least `from`");

/** What a source knows of a company, each field optional, at least one besides the name. */
export const companyFacts = z
  .strictObject({
    name: companyName.optional(),
    domain: companyDomain.optional(),
    linkedinUrl: companyPage.optional(),
    industry: text(INDUSTRY_MAX).optional(),
    employeeCount: z.int().min(EMPLOYEE_COUNT_MIN).optional(),
    employeeRange: employeeRange.optional(),
    country: countryCode.optional(),
    description: text(DESCRIPTION_MAX).optional(),
    foundedYear: z.int().min(FOUNDED_YEAR_MIN).max(FOUNDED_YEAR_MAX).optional(),
  })
  .refine(
    (facts) => Object.entries(facts).some(([key, value]) => key !== "name" && value !== undefined),
    "at least one fact besides the name",
  );

export const companyLookupResult = z.discriminatedUnion("result", [
  z.strictObject({ result: z.literal("found"), company: companyFacts }),
  z.strictObject({ result: z.literal("not_found") }),
]);

export type CompanyLookup = z.infer<typeof companyLookup>;
export type CompanyFacts = z.infer<typeof companyFacts>;
export type CompanyLookupResult = z.infer<typeof companyLookupResult>;

export const companyDataPort = definePort({
  name: "company_data",
  errorPrefix: "company_data",
  alwaysCheckOutputs: true,
  methods: {
    lookupCompany: { input: companyLookup, output: companyLookupResult },
  },
  errors: {
    /** The vendor's rate limit: `details.retryAfterSec`, the seconds it asks to wait. */
    company_data_rate_limited: { status: 429 },
    /** The vendor's free calls or credits are gone (its 402, or its own "quota used"): never retried. */
    company_data_allowance_spent: { status: 402 },
    /** The vendor refused the key. */
    company_data_unauthorized: { status: 401 },
    /** Anything else the vendor answered: `details.status`, never its body. */
    company_data_provider_error: { status: 502 },
  },
});

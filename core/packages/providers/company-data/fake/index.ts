// The company-data fake (README.md "The fake"): companies seeded in memory, each under a key, its
// LinkedIn page, its domain or its name, in any case; a lookup tries the page, then the domain, then
// the name, and answers a copy of the first company seeded under one of them, or not_found. It does
// not read countryHint. setAllowance() sets the allowance the bound fake exposes, so that
// enrichment's tests count against one; reset() clears it with the seeds. failNext()'s rate limit
// carries retryAfterSec and its provider error a status, as an adapter's do, unless the details
// give them. create() refuses APP_ENV=production: the fake never stands in for a vendor on a server.
import { AppError, platformConfig } from "@whytide/platform";
import { type Allowance, createFake, defineAdapter, patternErrors } from "../../_pattern/index.ts";
import { type CompanyFacts, companyDataPort } from "../port.ts";
import { PROVIDER_ERROR_STATUS, RETRY_AFTER_SEC } from "./constants.ts";

const { errors } = companyDataPort;

export const companyDataFake = createFake(companyDataPort, {
  state: () => ({
    companies: new Map<string, CompanyFacts>(),
    allowance: null as Allowance | null,
  }),
  methods: (fake) => ({
    lookupCompany: async ({ linkedinUrl, domain, name }) => {
      for (const key of [linkedinUrl, domain, name]) {
        const facts = key === undefined ? undefined : fake.state.companies.get(key.toLowerCase());
        if (facts) return { result: "found" as const, company: structuredClone(facts) };
      }
      return { result: "not_found" as const };
    },
  }),
  helpers: (fake) => ({
    /** A company a lookup finds by `key`: its LinkedIn page, its domain or its name, in any case. */
    seedCompany: (key: string, facts: CompanyFacts): void => {
      fake.state.companies.set(key.toLowerCase(), structuredClone(facts));
    },
    /** The allowance the bound fake exposes, null for none, until the next reset. */
    setAllowance: (allowance: Allowance | null): void => {
      fake.state.allowance = allowance;
    },
  }),
});

export type CompanyDataFake = typeof companyDataFake;

/** The details failNext adds when a test gives none, as an adapter's codes carry them. */
const DETAILS: Readonly<Record<string, Record<string, unknown>>> = {
  [errors.company_data_rate_limited]: { retryAfterSec: RETRY_AFTER_SEC },
  [errors.company_data_provider_error]: { status: PROVIDER_ERROR_STATUS },
};
const failNext = companyDataFake.failNext;
companyDataFake.failNext = (code, details) => {
  const defaults = DETAILS[code];
  failNext(code, defaults ? { ...defaults, ...details } : details);
};

export const companyDataFakeAdapter = defineAdapter(companyDataPort, {
  name: "fake",
  allowance: () => companyDataFake.state.allowance,
  create: () => {
    if (platformConfig.APP_ENV === "production") {
      const details = { port: companyDataPort.name, adapter: "fake", reason: "APP_ENV=production" };
      throw new AppError(patternErrors.adapter_invalid, { details });
    }
    return companyDataFake;
  },
});

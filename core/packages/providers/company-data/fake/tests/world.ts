// The fake as the contract's offline world (../../contract.ts): a synthetic company seeded under its
// LinkedIn page inside each case, after the suite's reset, and looked up by it; an unknown domain;
// failNext with the contract's seconds and status; the calls the fake recorded.
import {
  type OfflineWorld,
  PROVIDER_ERROR_STATUS,
  RETRY_AFTER_SEC,
  type WorldCompany,
} from "../../contract.ts";
import type { CompanyFacts } from "../../port.ts";
import type { CompanyDataFake } from "../index.ts";

export const PAGE = "https://www.linkedin.com/company/copper-harbor-labs";
/** Every fact the port has, synthetic. */
export const FACTS: CompanyFacts = {
  name: "Copper Harbor Labs",
  domain: "copper-harbor.example",
  linkedinUrl: PAGE,
  industry: "Software Development",
  employeeCount: 42,
  employeeRange: { from: 11, to: 50 },
  country: "GB",
  description: "A synthetic company of the contract suite.",
  foundedYear: 2019,
};

export const fakeWorld = (fake: CompanyDataFake): OfflineWorld => ({
  live: false,
  company: (): WorldCompany => {
    fake.seedCompany(PAGE, FACTS);
    return { lookup: { linkedinUrl: PAGE, countryHint: "GB" }, facts: FACTS };
  },
  unknown: () => ({ domain: "unknown-company.example" }),
  failNext: (code) => {
    if (code === "company_data_rate_limited") {
      fake.failNext(code, { retryAfterSec: RETRY_AFTER_SEC });
    } else if (code === "company_data_provider_error") {
      fake.failNext(code, { status: PROVIDER_ERROR_STATUS });
    } else {
      fake.failNext(code);
    }
  },
  calls: () => fake.recordedCalls.length,
});

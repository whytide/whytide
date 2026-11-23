// The fake as the contract's offline world (../../contract.ts): synthetic people at a reserved domain,
// found by default, one with the vendor's `catch_all` and one not found, set inside each case after
// the suite's reset; failNext with the contract's seconds and status; the calls the fake recorded.
import { type OfflineWorld, PROVIDER_ERROR_STATUS, RETRY_AFTER_SEC } from "../../contract.ts";
import type { EmailFinderFake } from "../index.ts";

export const DOMAIN = "copper-harbor.example";
export const ADA = { firstName: "Ada", lastName: "Example", companyDomain: DOMAIN };
export const GRACE = { firstName: "Grace", lastName: "Sample", companyDomain: DOMAIN };
export const NOBODY = { firstName: "Nobody", lastName: "Known", companyDomain: DOMAIN };

export const fakeWorld = (fake: EmailFinderFake): OfflineWorld => ({
  live: false,
  person: () => ({ person: ADA, address: `ada.example@${DOMAIN}` }),
  checked: () => {
    fake.vendorVerdictFor(GRACE.firstName, GRACE.lastName, DOMAIN, "catch_all");
    return { person: GRACE, address: `grace.sample@${DOMAIN}`, vendorVerdict: "catch_all" };
  },
  unknown: () => {
    fake.notFoundFor(NOBODY.firstName, NOBODY.lastName, DOMAIN);
    return NOBODY;
  },
  failNext: (code) => {
    if (code === "finder_rate_limited") {
      fake.failNext(code, { retryAfterSec: RETRY_AFTER_SEC });
    } else if (code === "finder_provider_error") {
      fake.failNext(code, { status: PROVIDER_ERROR_STATUS });
    } else {
      fake.failNext(code);
    }
  },
  calls: () => fake.recordedCalls.length,
});

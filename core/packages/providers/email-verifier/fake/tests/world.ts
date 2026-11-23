// The fake as the contract's offline world (../../contract.ts): a synthetic address per verdict, set
// with verdictFor() inside each case, after the suite's reset; failNext with the contract's seconds
// and status; the calls the fake recorded.
import { type OfflineWorld, PROVIDER_ERROR_STATUS, RETRY_AFTER_SEC } from "../../contract.ts";
import type { EmailVerdict } from "../../port.ts";
import type { EmailVerifierFake } from "../index.ts";

/** A synthetic address at a reserved domain, one per verdict. */
export const addressWith = (verdict: EmailVerdict) => `ada.${verdict}@copper-harbor.example`;

export const fakeWorld = (fake: EmailVerifierFake): OfflineWorld => ({
  live: false,
  address: (verdict) => {
    fake.verdictFor(addressWith(verdict), verdict);
    return addressWith(verdict);
  },
  failNext: (code) => {
    if (code === "verifier_rate_limited") {
      fake.failNext(code, { retryAfterSec: RETRY_AFTER_SEC });
    } else if (code === "verifier_provider_error") {
      fake.failNext(code, { status: PROVIDER_ERROR_STATUS });
    } else {
      fake.failNext(code);
    }
  },
  calls: () => fake.recordedCalls.length,
});

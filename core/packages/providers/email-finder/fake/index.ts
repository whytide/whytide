// The email-finder fake (README.md "The fake"): it finds `<first>.<last>@<companyDomain>` for every
// person, each name lower case, its accents and marks dropped and anything but a to z and digits
// left out, and answers not_found when a name keeps nothing. notFoundFor() makes it answer not_found
// for a person, and vendorVerdictFor() makes it answer the address with a vendor's own verdict, any of
// the five; the last set for a person wins. setAllowance() sets the allowance the bound fake exposes,
// so that enrichment's tests count against one; reset() clears it with the answers. failNext()'s rate
// limit carries retryAfterSec and its provider error a status, as an adapter's do, unless the details
// give them. create() refuses APP_ENV=production: the fake never stands in for a vendor on a server.
import { AppError, platformConfig } from "@whytide/platform";
import { type Allowance, createFake, defineAdapter, patternErrors } from "../../_pattern/index.ts";
import type { VENDOR_VERDICTS } from "../constants.ts";
import { emailFinderPort, type FindEmailResult } from "../port.ts";
import {
  MARKS,
  NAME_JOIN,
  NOT_IN_ADDRESS,
  PROVIDER_ERROR_STATUS,
  RETRY_AFTER_SEC,
} from "./constants.ts";

const { errors } = emailFinderPort;
type VendorVerdict = (typeof VENDOR_VERDICTS)[number];
/** What a helper set for a person: not found, or found with the vendor's verdict. */
type Answer =
  | { readonly result: "not_found" }
  | { readonly result: "found"; readonly vendorVerdict: VendorVerdict };

/** One person at one domain, in any case. */
const personKey = (firstName: string, lastName: string, companyDomain: string) =>
  JSON.stringify([firstName, lastName, companyDomain].map((part) => part.toLowerCase()));
/** A name as the address holds it: lower case, no mark, nothing but a to z and digits. */
const addressPart = (name: string) =>
  name.normalize("NFKD").replace(MARKS, "").toLowerCase().replace(NOT_IN_ADDRESS, "");

export const emailFinderFake = createFake(emailFinderPort, {
  state: () => ({
    answers: new Map<string, Answer>(),
    allowance: null as Allowance | null,
  }),
  methods: (fake) => ({
    findEmail: async ({ firstName, lastName, companyDomain }): Promise<FindEmailResult> => {
      const answer = fake.state.answers.get(personKey(firstName, lastName, companyDomain));
      const parts = [firstName, lastName].map(addressPart);
      if (answer?.result === "not_found" || parts.includes("")) return { result: "not_found" };
      const address = `${parts.join(NAME_JOIN)}@${companyDomain}`;
      if (answer === undefined) return { result: "found", address };
      return { result: "found", address, vendorVerdict: answer.vendorVerdict };
    },
  }),
  helpers: (fake) => ({
    /** The person, in any case, is not found until the next reset. */
    notFoundFor: (firstName: string, lastName: string, companyDomain: string): void => {
      const key = personKey(firstName, lastName, companyDomain);
      fake.state.answers.set(key, { result: "not_found" });
    },
    /** The person's address comes with the vendor's own `verdict`, any of the five, until the next reset. */
    vendorVerdictFor: (
      firstName: string,
      lastName: string,
      companyDomain: string,
      verdict: VendorVerdict,
    ): void => {
      const key = personKey(firstName, lastName, companyDomain);
      fake.state.answers.set(key, { result: "found", vendorVerdict: verdict });
    },
    /** The allowance the bound fake exposes, null for none, until the next reset. */
    setAllowance: (allowance: Allowance | null): void => {
      fake.state.allowance = allowance;
    },
  }),
});

export type EmailFinderFake = typeof emailFinderFake;

/** The details failNext adds when a test gives none, as an adapter's codes carry them. */
const DETAILS: Readonly<Record<string, Record<string, unknown>>> = {
  [errors.finder_rate_limited]: { retryAfterSec: RETRY_AFTER_SEC },
  [errors.finder_provider_error]: { status: PROVIDER_ERROR_STATUS },
};
const failNext = emailFinderFake.failNext;
emailFinderFake.failNext = (code, details) => {
  const defaults = DETAILS[code];
  failNext(code, defaults ? { ...defaults, ...details } : details);
};

export const emailFinderFakeAdapter = defineAdapter(emailFinderPort, {
  name: "fake",
  allowance: () => emailFinderFake.state.allowance,
  create: () => {
    if (platformConfig.APP_ENV === "production") {
      const details = { port: emailFinderPort.name, adapter: "fake", reason: "APP_ENV=production" };
      throw new AppError(patternErrors.adapter_invalid, { details });
    }
    return emailFinderFake;
  },
});

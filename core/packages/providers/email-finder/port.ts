// The email-finder port (docs/architecture.md §9, docs/rules/coding.md §6; briefs RB-7.1.1 reduced,
// RB-7.3.1): a person's work address from their name and their company's domain, in our words
// (README.md). One method, findEmail(). The input is the first name, the last name and the company
// domain, a strict object, so that nothing else about the person reaches a finder; the output is the
// address found, with the vendor's own verdict when it checked the address itself, or not_found,
// strict and checked in every environment, production included. Each adapter declares its free
// allowance; enrichment counts the calls and asks the adapters of PROVIDER_EMAIL_FINDER in its order
// (../README.md "Many adapters per port").
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";
import {
  ADDRESS,
  ADDRESS_MAX,
  COMPANY_DOMAIN,
  DOMAIN_MAX,
  NAME_MAX,
  NOT_BLANK,
  VENDOR_VERDICTS,
} from "./constants.ts";

export { emailFinderConfig } from "./config.ts";
export type { EmailFinderFake } from "./fake/index.ts";

const personName = z.string().min(1).max(NAME_MAX).regex(NOT_BLANK, "not blank");
/** A host name, lower case, without `www.`. */
const companyDomain = z
  .string()
  .max(DOMAIN_MAX)
  .regex(COMPANY_DOMAIN, "a host name, lower case, without www.");

/** What a lookup takes: the first name, the last name and the company's domain. Nothing else. */
export const findEmailInput = z.strictObject({
  firstName: personName,
  lastName: personName,
  companyDomain,
});

export const findEmailResult = z.discriminatedUnion("result", [
  z.strictObject({
    result: z.literal("found"),
    /** Lower case, at any domain: enrichment decides what one off the company's domain means. */
    address: z.string().max(ADDRESS_MAX).regex(ADDRESS, "an address, lower case"),
    /** The vendor's own check of the address, one of the five verdicts; absent when it made none. */
    vendorVerdict: z.enum(VENDOR_VERDICTS).optional(),
  }),
  z.strictObject({ result: z.literal("not_found") }),
]);

export type FindEmailInput = z.infer<typeof findEmailInput>;
export type FindEmailResult = z.infer<typeof findEmailResult>;

export const emailFinderPort = definePort({
  name: "email_finder",
  errorPrefix: "finder",
  alwaysCheckOutputs: true,
  methods: {
    findEmail: { input: findEmailInput, output: findEmailResult },
  },
  errors: {
    /** The vendor's rate limit: `details.retryAfterSec`, the seconds it asks to wait. */
    finder_rate_limited: { status: 429 },
    /** The vendor's free searches or credits are gone (its 402, or its own "quota used"): never retried. */
    finder_allowance_spent: { status: 402 },
    /** The vendor refused the key. */
    finder_unauthorized: { status: 401 },
    /** Anything else the vendor answered: `details.status`, never its body. */
    finder_provider_error: { status: 502 },
  },
});

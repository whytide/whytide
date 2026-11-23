// The email-verifier port (docs/architecture.md §9, docs/rules/coding.md §6; briefs RB-7.1.1 reduced,
// RB-7.3.1): one address's verdict, in our words (README.md). One method, verifyEmail(). The input is
// the address and nothing else, a strict object, so that nothing about the person reaches a
// verifier; the output is one of the five verdicts and the time of the check, strict and checked in
// every environment, production included. Each adapter declares its free allowance; enrichment
// counts the calls and gives the adapters of PROVIDER_EMAIL_VERIFIER their turns in its order
// (../README.md "Many adapters per port").
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";
import { ADDRESS, ADDRESS_MAX, EMAIL_VERDICTS } from "./constants.ts";

export { emailVerifierConfig } from "./config.ts";
export type { EmailVerifierFake } from "./fake/index.ts";

/** One of the five verdicts: valid, catch_all, risky, invalid, unknown. */
export const emailVerdict = z.enum(EMAIL_VERDICTS);
/** An address, lower case, plain: no display name, quotes or space. */
const address = z.string().max(ADDRESS_MAX).regex(ADDRESS, "an address, lower case");

/** What a check takes: the address. Nothing else. */
export const verifyEmailInput = z.strictObject({ address });
export const verifyEmailResult = z.strictObject({ verdict: emailVerdict, checkedAt: z.date() });

export type EmailVerdict = z.infer<typeof emailVerdict>;
export type VerifyEmailInput = z.infer<typeof verifyEmailInput>;
export type VerifyEmailResult = z.infer<typeof verifyEmailResult>;

export const emailVerifierPort = definePort({
  name: "email_verifier",
  errorPrefix: "verifier",
  alwaysCheckOutputs: true,
  methods: {
    verifyEmail: { input: verifyEmailInput, output: verifyEmailResult },
  },
  errors: {
    /** The vendor's rate limit: `details.retryAfterSec`, the seconds it asks to wait. */
    verifier_rate_limited: { status: 429 },
    /** The vendor's free checks or credits are gone (its 402, or its own "quota used"): never retried. */
    verifier_allowance_spent: { status: 402 },
    /** The vendor refused the key. */
    verifier_unauthorized: { status: 401 },
    /** Anything else the vendor answered: `details.status`, never its body. */
    verifier_provider_error: { status: 502 },
  },
});

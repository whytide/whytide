// The email-verifier fake (README.md "The fake"): every address is `valid`, checked now, unless
// verdictFor() set another verdict for it, any of the five. setAllowance() sets the allowance the
// bound fake exposes, so that enrichment's tests count against one; reset() clears it with the
// verdicts. failNext()'s rate limit carries retryAfterSec and its provider error a status, as an
// adapter's do, unless the details give them. create() refuses APP_ENV=production: the fake never
// stands in for a vendor on a server.
import { AppError, platformConfig } from "@whytide/platform";
import { type Allowance, createFake, defineAdapter, patternErrors } from "../../_pattern/index.ts";
import { type EmailVerdict, emailVerifierPort } from "../port.ts";
import { DEFAULT_VERDICT, PROVIDER_ERROR_STATUS, RETRY_AFTER_SEC } from "./constants.ts";

const { errors } = emailVerifierPort;

export const emailVerifierFake = createFake(emailVerifierPort, {
  state: () => ({
    verdicts: new Map<string, EmailVerdict>(),
    allowance: null as Allowance | null,
  }),
  methods: (fake) => ({
    verifyEmail: async ({ address }) => ({
      verdict: fake.state.verdicts.get(address) ?? DEFAULT_VERDICT,
      checkedAt: new Date(),
    }),
  }),
  helpers: (fake) => ({
    /** The verdict a check of `address`, in any case, answers until the next reset; else `valid`. */
    verdictFor: (address: string, verdict: EmailVerdict): void => {
      fake.state.verdicts.set(address.toLowerCase(), verdict);
    },
    /** The allowance the bound fake exposes, null for none, until the next reset. */
    setAllowance: (allowance: Allowance | null): void => {
      fake.state.allowance = allowance;
    },
  }),
});

export type EmailVerifierFake = typeof emailVerifierFake;

/** The details failNext adds when a test gives none, as an adapter's codes carry them. */
const DETAILS: Readonly<Record<string, Record<string, unknown>>> = {
  [errors.verifier_rate_limited]: { retryAfterSec: RETRY_AFTER_SEC },
  [errors.verifier_provider_error]: { status: PROVIDER_ERROR_STATUS },
};
const failNext = emailVerifierFake.failNext;
emailVerifierFake.failNext = (code, details) => {
  const defaults = DETAILS[code];
  failNext(code, defaults ? { ...defaults, ...details } : details);
};

export const emailVerifierFakeAdapter = defineAdapter(emailVerifierPort, {
  name: "fake",
  allowance: () => emailVerifierFake.state.allowance,
  create: () => {
    if (platformConfig.APP_ENV === "production") {
      const details = {
        port: emailVerifierPort.name,
        adapter: "fake",
        reason: "APP_ENV=production",
      };
      throw new AppError(patternErrors.adapter_invalid, { details });
    }
    return emailVerifierFake;
  },
});

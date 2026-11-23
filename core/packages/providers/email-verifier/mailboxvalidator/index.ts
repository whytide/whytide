// The mailboxvalidator adapter of the email-verifier port (README.md): MailboxValidator's v2 single
// validation, on the free plan's 300 checks a month. It sends the address and the key, and maps the
// answer's flags onto the five verdicts (README.md "Mapping"): a catch-all domain is catch_all, never
// valid. No SDK, no retry: enrichment counts the checks and passes the address to the next verifier
// on any code.
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { checked, missingVariable, offShape, providerError } from "../answer.ts";
import { type EmailVerdict, emailVerifierPort } from "../port.ts";
import { errorOf, mbvClient } from "./client.ts";
import { mailboxValidatorConfig } from "./config.ts";
import { KEY_VARIABLE, MBV_ORIGIN, TIMEOUT_MS } from "./constants.ts";

/** The parts of the answer the adapter reads, each true, false or null; every other field is left unread. */
type Validation = {
  readonly error?: unknown;
  readonly status?: unknown;
  readonly is_syntax?: unknown;
  readonly is_domain?: unknown;
  readonly is_verified?: unknown;
  readonly is_catchall?: unknown;
  readonly is_disposable?: unknown;
  readonly is_role?: unknown;
  readonly is_suppressed?: unknown;
  readonly is_high_risk?: unknown;
};

export type MbvOptions = {
  /** The vendor's fixed host; a test's server on 127.0.0.1. */
  readonly origin: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

/** The adapter on `origin` with `apiKey`: what create() returns on the vendor's host. */
export function mbvEmailVerifier(
  options: MbvOptions,
): PortImplementation<typeof emailVerifierPort> {
  const { origin, apiKey, timeoutMs = TIMEOUT_MS, now = Date.now } = options;
  const client = mbvClient(origin, apiKey, timeoutMs, now);
  return {
    verifyEmail: async ({ address }) => {
      const { status, body } = await client(address);
      const answer = body as Validation | null;
      if (answer?.error !== undefined) throw errorOf(status, answer) ?? providerError({ status });
      return checked(verdictOf(answer), now);
    },
  };
}

export const mailboxValidatorAdapter = defineAdapter(emailVerifierPort, {
  name: "mailboxvalidator",
  requires: [KEY_VARIABLE],
  allowance: mailboxValidatorConfig.MAILBOXVALIDATOR_ALLOWANCE,
  create: () => {
    const apiKey = mailboxValidatorConfig.MAILBOXVALIDATOR_API_KEY;
    if (!apiKey) throw missingVariable(KEY_VARIABLE, "mailboxvalidator");
    return mbvEmailVerifier({ origin: MBV_ORIGIN, apiKey });
  },
});

/**
 * The README's mapping table: an address that fails a check first; then the catch-all flag, whatever
 * else the answer says; then the risky flags; then the vendor's own status; else unknown.
 */
function verdictOf(answer: Validation | null): EmailVerdict {
  if (typeof answer?.status !== "boolean") throw offShape();
  const { is_syntax, is_domain, is_verified } = answer;
  if (is_syntax === false || is_domain === false || is_verified === false) return "invalid";
  if (answer.is_catchall === true) return "catch_all";
  const risky = [answer.is_disposable, answer.is_role, answer.is_suppressed, answer.is_high_risk];
  if (risky.includes(true)) return "risky";
  return answer.status && is_verified === true ? "valid" : "unknown";
}

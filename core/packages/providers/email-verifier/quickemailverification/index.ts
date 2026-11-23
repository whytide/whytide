// The quickemailverification adapter of the email-verifier port (README.md): QuickEmailVerification's
// /v1/verify, on the free plan's 100 checks a day. It sends the address and the key, and maps the
// answer onto the five verdicts (README.md "Mapping"): an accept-all domain is catch_all, never
// valid. No SDK, no retry: enrichment counts the checks and passes the address to the next verifier
// on any code.
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { checked, missingVariable, offShape, yes } from "../answer.ts";
import { type EmailVerdict, emailVerifierPort } from "../port.ts";
import { qevClient } from "./client.ts";
import { quickEmailVerificationConfig } from "./config.ts";
import { FULL_MAILBOX, KEY_VARIABLE, QEV_ORIGIN, RESULT, TIMEOUT_MS } from "./constants.ts";

/** The parts of the answer the adapter reads; every other field is left unread. */
type Verified = {
  readonly success?: unknown;
  readonly result?: unknown;
  readonly reason?: unknown;
  readonly accept_all?: unknown;
  readonly disposable?: unknown;
  readonly role?: unknown;
};

export type QevOptions = {
  /** The vendor's fixed host; a test's server on 127.0.0.1. */
  readonly origin: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

/** The adapter on `origin` with `apiKey`: what create() returns on the vendor's host. */
export function qevEmailVerifier(
  options: QevOptions,
): PortImplementation<typeof emailVerifierPort> {
  const { origin, apiKey, timeoutMs = TIMEOUT_MS, now = Date.now } = options;
  const client = qevClient(origin, apiKey, timeoutMs, now);
  return {
    verifyEmail: async ({ address }) => {
      const { body } = await client(address);
      return checked(verdictOf(body as Verified | null), now);
    },
  };
}

export const quickEmailVerificationAdapter = defineAdapter(emailVerifierPort, {
  name: "quickemailverification",
  requires: [KEY_VARIABLE],
  allowance: quickEmailVerificationConfig.QUICKEMAILVERIFICATION_ALLOWANCE,
  create: () => {
    const apiKey = quickEmailVerificationConfig.QUICKEMAILVERIFICATION_API_KEY;
    if (!apiKey) throw missingVariable(KEY_VARIABLE, "quickemailverification");
    return qevEmailVerifier({ origin: QEV_ORIGIN, apiKey });
  },
});

/**
 * The README's mapping table: an invalid result first; then the accept-all flag, whatever else the
 * answer says; then the risky flags and a full mailbox; then the result.
 */
function verdictOf(answer: Verified | null): EmailVerdict {
  if (!yes(answer?.success) || typeof answer?.result !== "string") throw offShape();
  const { result } = answer;
  if (result === RESULT.invalid && answer.reason !== FULL_MAILBOX) return "invalid";
  if (yes(answer.accept_all)) return "catch_all";
  if (yes(answer.disposable) || yes(answer.role) || answer.reason === FULL_MAILBOX) return "risky";
  return result === RESULT.valid ? "valid" : "unknown";
}

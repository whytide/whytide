// The reoon adapter of the email-verifier port (README.md): Reoon Email Verifier's single check in
// power mode, on the free plan's 20 checks a day. It sends the address, the key and the mode, and
// maps the answer's status onto the five verdicts (README.md "Mapping"): a catch-all domain is
// catch_all, never valid. No SDK, no retry: enrichment counts the checks and passes the address to
// the next verifier on any code.
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { checked, missingVariable, offShape, providerError, yes } from "../answer.ts";
import { type EmailVerdict, emailVerifierPort } from "../port.ts";
import { errorOf, reoonClient } from "./client.ts";
import { reoonConfig } from "./config.ts";
import {
  CATCH_ALL,
  ERROR_STATUS,
  INVALID_STATUSES,
  KEY_VARIABLE,
  REOON_ORIGIN,
  RISKY_STATUSES,
  SAFE,
  TIMEOUT_MS,
} from "./constants.ts";

/** The parts of the answer the adapter reads; every other field is left unread. */
type Verification = { readonly status?: unknown; readonly is_catch_all?: unknown };

export type ReoonOptions = {
  /** The vendor's fixed host; a test's server on 127.0.0.1. */
  readonly origin: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

/** The adapter on `origin` with `apiKey`: what create() returns on the vendor's host. */
export function reoonEmailVerifier(
  options: ReoonOptions,
): PortImplementation<typeof emailVerifierPort> {
  const { origin, apiKey, timeoutMs = TIMEOUT_MS, now = Date.now } = options;
  const client = reoonClient(origin, apiKey, timeoutMs, now);
  return {
    verifyEmail: async ({ address }) => {
      const { status, body } = await client(address);
      const answer = body as Verification | null;
      if (answer?.status === ERROR_STATUS)
        throw errorOf(status, answer) ?? providerError({ status });
      return checked(verdictOf(answer), now);
    },
  };
}

export const reoonAdapter = defineAdapter(emailVerifierPort, {
  name: "reoon",
  requires: [KEY_VARIABLE],
  allowance: reoonConfig.REOON_ALLOWANCE,
  create: () => {
    const apiKey = reoonConfig.REOON_API_KEY;
    if (!apiKey) throw missingVariable(KEY_VARIABLE, "reoon");
    return reoonEmailVerifier({ origin: REOON_ORIGIN, apiKey });
  },
});

/**
 * The README's mapping table: invalid and disabled first; then the catch-all status or flag, whatever
 * else the answer says; then the statuses not to mail; then safe; else unknown.
 */
function verdictOf(answer: Verification | null): EmailVerdict {
  if (typeof answer?.status !== "string") throw offShape();
  const { status } = answer;
  if (INVALID_STATUSES.has(status)) return "invalid";
  if (status === CATCH_ALL || yes(answer.is_catch_all)) return "catch_all";
  if (RISKY_STATUSES.has(status)) return "risky";
  return status === SAFE ? "valid" : "unknown";
}

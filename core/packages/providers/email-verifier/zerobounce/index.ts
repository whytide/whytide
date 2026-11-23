// The zerobounce adapter of the email-verifier port (README.md): ZeroBounce's v2 validate, on the free
// plan's 100 checks a month. It sends the address and the key, and maps the answer's status and
// sub-status onto the five verdicts (README.md "Mapping"): an accept-all domain, ZeroBounce's own
// `catch-all` or its vetted `accept_all`, is catch_all, never valid. No SDK, no retry: enrichment
// counts the checks and passes the address to the next verifier on any code.
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { checked, missingVariable, offShape, providerError, yes } from "../answer.ts";
import { type EmailVerdict, emailVerifierPort } from "../port.ts";
import { errorOf, zeroBounceClient } from "./client.ts";
import { zeroBounceConfig } from "./config.ts";
import {
  ACCEPT_ALL,
  FULL_MAILBOX,
  KEY_VARIABLE,
  RISKY_STATUSES,
  STATUS,
  TIMEOUT_MS,
  ZEROBOUNCE_ORIGIN,
} from "./constants.ts";

/** The parts of the answer the adapter reads; every other field, the person's name among them, is left unread. */
type Validation = {
  readonly error?: unknown;
  readonly status?: unknown;
  readonly sub_status?: unknown;
  readonly catchall_domain?: unknown;
};

export type ZeroBounceOptions = {
  /** The vendor's fixed host; a test's server on 127.0.0.1. */
  readonly origin: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

/** The adapter on `origin` with `apiKey`: what create() returns on the vendor's host. */
export function zeroBounceEmailVerifier(
  options: ZeroBounceOptions,
): PortImplementation<typeof emailVerifierPort> {
  const { origin, apiKey, timeoutMs = TIMEOUT_MS, now = Date.now } = options;
  const client = zeroBounceClient(origin, apiKey, timeoutMs, now);
  return {
    verifyEmail: async ({ address }) => {
      const { status, body } = await client(address);
      const answer = body as Validation | null;
      if (answer?.error !== undefined) throw errorOf(status, answer) ?? providerError({ status });
      return checked(verdictOf(answer), now);
    },
  };
}

export const zeroBounceAdapter = defineAdapter(emailVerifierPort, {
  name: "zerobounce",
  requires: [KEY_VARIABLE],
  allowance: zeroBounceConfig.ZEROBOUNCE_ALLOWANCE,
  create: () => {
    const apiKey = zeroBounceConfig.ZEROBOUNCE_API_KEY;
    if (!apiKey) throw missingVariable(KEY_VARIABLE, "zerobounce");
    return zeroBounceEmailVerifier({ origin: ZEROBOUNCE_ORIGIN, apiKey });
  },
});

/**
 * The README's mapping table: invalid first, a full mailbox aside; then any accept-all sign, whatever
 * else the answer says; then the statuses not to mail and a full mailbox; then valid; else unknown.
 */
function verdictOf(answer: Validation | null): EmailVerdict {
  if (typeof answer?.status !== "string") throw offShape();
  const { status, sub_status } = answer;
  if (status === STATUS.invalid && sub_status !== FULL_MAILBOX) return "invalid";
  const acceptAll =
    status === STATUS.catchAll || ACCEPT_ALL.has(sub_status) || yes(answer.catchall_domain);
  if (acceptAll) return "catch_all";
  if (RISKY_STATUSES.has(status) || sub_status === FULL_MAILBOX) return "risky";
  return status === STATUS.valid ? "valid" : "unknown";
}

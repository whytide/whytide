// The verifalia adapter of the email-verifier port (README.md): Verifalia's email validation jobs, on
// the free plan's 25 checks a day, by a user made for Whytide with verification rights only. It sends
// the address alone, as a job of one entry read until done within 10 seconds, and maps the entry's
// status and classification onto the five verdicts (README.md "Mapping"): a catch-all server is
// catch_all, never valid. No SDK, no retry: enrichment counts the checks and passes the address to
// the next verifier on any code, a job not done in time included.
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { checked, missingVariable, offShape } from "../answer.ts";
import { type EmailVerdict, emailVerifierPort } from "../port.ts";
import { verifaliaClient } from "./client.ts";
import { verifaliaConfig } from "./config.ts";
import {
  BUDGET_MS,
  CLASSIFICATION_VERDICTS,
  COMPLETED,
  PASSWORD_VARIABLE,
  STATUS_VERDICTS,
  USERNAME_VARIABLE,
  VERIFALIA_ORIGIN,
} from "./constants.ts";

/** The parts of a finished job the adapter reads; every other field is left unread. */
type Job = {
  readonly overview?: { readonly status?: unknown } | null;
  readonly entries?: {
    readonly data?: readonly { readonly classification?: unknown; readonly status?: unknown }[];
  } | null;
};

export type VerifaliaOptions = {
  /** The vendor's fixed host; a test's server on 127.0.0.1. */
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly budgetMs?: number;
  readonly now?: () => number;
};

/** The adapter on `origin` with the user's credentials: what create() returns on the vendor's host. */
export function verifaliaEmailVerifier(
  options: VerifaliaOptions,
): PortImplementation<typeof emailVerifierPort> {
  const { origin, username, password, budgetMs = BUDGET_MS, now = Date.now } = options;
  const client = verifaliaClient(origin, { username, password }, budgetMs, now);
  return {
    verifyEmail: async ({ address }) => checked(verdictOf((await client(address)) as Job), now),
  };
}

export const verifaliaAdapter = defineAdapter(emailVerifierPort, {
  name: "verifalia",
  requires: [USERNAME_VARIABLE, PASSWORD_VARIABLE],
  allowance: verifaliaConfig.VERIFALIA_ALLOWANCE,
  create: () => {
    const { VERIFALIA_USERNAME: username, VERIFALIA_PASSWORD: password } = verifaliaConfig;
    if (!username) throw missingVariable(USERNAME_VARIABLE, "verifalia");
    if (!password) throw missingVariable(PASSWORD_VARIABLE, "verifalia");
    return verifaliaEmailVerifier({ origin: VERIFALIA_ORIGIN, username, password });
  },
});

/**
 * The README's mapping table, on the job's one entry: its status first where it decides (a catch-all
 * server, a full mailbox, a disposable or honeypot domain), else its classification; else unknown.
 */
function verdictOf(job: Job | null): EmailVerdict {
  const entry = job?.entries?.data?.[0];
  if (job?.overview?.status !== COMPLETED || entry === undefined) throw offShape();
  const { status, classification } = entry;
  if (typeof status !== "string" || typeof classification !== "string") throw offShape();
  return (
    (Object.hasOwn(STATUS_VERDICTS, status) ? STATUS_VERDICTS[status] : undefined) ??
    (Object.hasOwn(CLASSIFICATION_VERDICTS, classification)
      ? CLASSIFICATION_VERDICTS[classification]
      : undefined) ??
    "unknown"
  );
}

// The snov adapter of the email-finder port (README.md): Snov.io's Email Finder by name and domain,
// on the free plan's 50 credits a month. One task with the first name, the last name and the domain,
// and nothing else; its result read within the 10-second budget (client.ts). Snov.io's addresses
// come with its own SMTP check: the adapter takes the first valid one, else the first, and maps its
// check onto the five verdicts, a catch-all never valid, a webmail or disposable address risky
// (README.md "Mapping"). No SDK, no retry: enrichment asks the next finder on any error.
import { z } from "zod";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { foundOf, missingVariable, shaped } from "../answer.ts";
import type { VENDOR_VERDICTS } from "../constants.ts";
import { emailFinderPort } from "../port.ts";
import { snovClient } from "./client.ts";
import { snovConfig } from "./config.ts";
import {
  BUDGET_MS,
  CATCH_ALL_REASON,
  ID_VARIABLE,
  POLL_MS,
  SECRET_VARIABLE,
  SMTP_UNKNOWN,
  SMTP_VALID,
  SNOV_ORIGIN,
} from "./constants.ts";

export type SnovOptions = {
  /** Snov.io's fixed host; a test's server on 127.0.0.1. */
  readonly origin: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly budgetMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
};

/** The parts of the completed result the adapter reads: each address and its checks, nothing else. */
const email = z.object({
  email: z.string().nullish(),
  smtp_status: z.string().nullish(),
  unknown_status_reason: z.string().nullish(),
  is_valid_format: z.boolean().nullish(),
  is_disposable: z.boolean().nullish(),
  is_webmail: z.boolean().nullish(),
});
type Email = z.infer<typeof email>;
const resultAnswer = z.object({
  data: z.array(z.object({ result: z.array(email).nullish() })).nullish(),
});

/** The adapter on `origin` with the client's id and secret: what create() returns on Snov.io's host. */
export function snovEmailFinder(options: SnovOptions): PortImplementation<typeof emailFinderPort> {
  const { origin, clientId, clientSecret, budgetMs = BUDGET_MS, pollMs = POLL_MS } = options;
  const client = snovClient({
    origin,
    clientId,
    clientSecret,
    budgetMs,
    pollMs,
    now: options.now ?? Date.now,
  });
  return {
    findEmail: async (input) => {
      const { data } = shaped(resultAnswer, await client(input));
      const emails = (data?.[0]?.result ?? []).filter((one) => one.is_valid_format !== false);
      const chosen = emails.find((one) => one.smtp_status === SMTP_VALID) ?? emails[0];
      return foundOf(chosen?.email, chosen && verdictOf(chosen));
    },
  };
}

export const snovAdapter = defineAdapter(emailFinderPort, {
  name: "snov",
  requires: [ID_VARIABLE, SECRET_VARIABLE],
  allowance: snovConfig.SNOV_ALLOWANCE,
  create: () => {
    const { SNOV_CLIENT_ID: clientId, SNOV_CLIENT_SECRET: clientSecret } = snovConfig;
    if (!clientId) throw missingVariable(ID_VARIABLE, "snov");
    if (!clientSecret) throw missingVariable(SECRET_VARIABLE, "snov");
    return snovEmailFinder({ origin: SNOV_ORIGIN, clientId, clientSecret });
  },
});

/** Snov.io's checks as one verdict: webmail or disposable risky, then its SMTP status. */
function verdictOf(one: Email): (typeof VENDOR_VERDICTS)[number] | undefined {
  if (one.is_disposable || one.is_webmail) return "risky";
  if (one.smtp_status === SMTP_VALID) return "valid";
  if (one.smtp_status !== SMTP_UNKNOWN) return undefined;
  return one.unknown_status_reason === CATCH_ALL_REASON ? "catch_all" : "unknown";
}

// The hunter adapter of the email-finder port (README.md): Hunter's Email Finder, on the free plan's
// 50 credits a month. One GET with the domain, the first name and the last name, and nothing else;
// the key in X-API-KEY. Hunter's address comes with its own check, `verification.status` and the
// domain's `accept_all`, mapped onto the five verdicts, accept-all never valid (README.md "Mapping").
// No SDK, no retry: enrichment asks the next finder on any error.
import { z } from "zod";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { foundOf, missingVariable, NOT_FOUND, shaped } from "../answer.ts";
import { emailFinderPort } from "../port.ts";
import { hunterClient } from "./client.ts";
import { hunterConfig } from "./config.ts";
import { HUNTER_ORIGIN, KEY_VARIABLE, TIMEOUT_MS, VERDICTS } from "./constants.ts";

export type HunterOptions = {
  /** Hunter's fixed host; a test's server on 127.0.0.1. */
  readonly origin: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

/** The parts of Hunter's answer the adapter reads; every other field (the sources, the person) is left unread. */
const hunterAnswer = z.object({
  data: z
    .object({
      email: z.string().nullish(),
      accept_all: z.boolean().nullish(),
      verification: z.object({ status: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

/** The adapter on `origin` with `apiKey`: what create() returns on Hunter's host. */
export function hunterEmailFinder(
  options: HunterOptions,
): PortImplementation<typeof emailFinderPort> {
  const { origin, apiKey, timeoutMs = TIMEOUT_MS, now = Date.now } = options;
  const client = hunterClient(origin, apiKey, timeoutMs, now);
  return {
    findEmail: async (input) => {
      const answer = await client(input);
      if (answer === NOT_FOUND) return NOT_FOUND;
      const { data } = shaped(hunterAnswer, answer);
      const verdict = data?.accept_all ? "catch_all" : VERDICTS[data?.verification?.status ?? ""];
      return foundOf(data?.email, verdict);
    },
  };
}

export const hunterAdapter = defineAdapter(emailFinderPort, {
  name: "hunter",
  requires: [KEY_VARIABLE],
  allowance: hunterConfig.HUNTER_ALLOWANCE,
  create: () => {
    const apiKey = hunterConfig.HUNTER_API_KEY;
    if (!apiKey) throw missingVariable(KEY_VARIABLE, "hunter");
    return hunterEmailFinder({ origin: HUNTER_ORIGIN, apiKey });
  },
});

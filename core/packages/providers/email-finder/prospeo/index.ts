// The prospeo adapter of the email-finder port (README.md): Prospeo's Enrich Person, on the free
// plan's 75 credits a month. One POST with the first name, the last name and the company's website,
// and nothing else about the person; `only_verified_email`, so that Prospeo answers, and charges
// for, only an address it verified itself: `VERIFIED` is the port's `valid` (README.md "Mapping").
// The rest of Prospeo's person and company records is left unread. No SDK, no retry: enrichment
// asks the next finder on any error.
import { z } from "zod";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { foundOf, missingVariable, NOT_FOUND, shaped } from "../answer.ts";
import { emailFinderPort } from "../port.ts";
import { prospeoClient } from "./client.ts";
import { prospeoConfig } from "./config.ts";
import { KEY_VARIABLE, PROSPEO_ORIGIN, TIMEOUT_MS, VERIFIED } from "./constants.ts";

export type ProspeoOptions = {
  /** Prospeo's fixed host; a test's server on 127.0.0.1. */
  readonly origin: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

/** The parts of Prospeo's answer the adapter reads: the person's email, and nothing else. */
const prospeoAnswer = z.object({
  person: z
    .object({
      email: z
        .object({
          status: z.string().nullish(),
          revealed: z.boolean().nullish(),
          email: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/** The adapter on `origin` with `apiKey`: what create() returns on Prospeo's host. */
export function prospeoEmailFinder(
  options: ProspeoOptions,
): PortImplementation<typeof emailFinderPort> {
  const { origin, apiKey, timeoutMs = TIMEOUT_MS, now = Date.now } = options;
  const client = prospeoClient(origin, apiKey, timeoutMs, now);
  return {
    findEmail: async (input) => {
      const answer = await client(input);
      if (answer === NOT_FOUND) return NOT_FOUND;
      const email = shaped(prospeoAnswer, answer).person?.email;
      // An address not revealed is a masked snippet, never an address.
      if (email?.revealed === false) return NOT_FOUND;
      return foundOf(email?.email, email?.status === VERIFIED ? "valid" : undefined);
    },
  };
}

export const prospeoAdapter = defineAdapter(emailFinderPort, {
  name: "prospeo",
  requires: [KEY_VARIABLE],
  allowance: prospeoConfig.PROSPEO_ALLOWANCE,
  create: () => {
    const apiKey = prospeoConfig.PROSPEO_API_KEY;
    if (!apiKey) throw missingVariable(KEY_VARIABLE, "prospeo");
    return prospeoEmailFinder({ origin: PROSPEO_ORIGIN, apiKey });
  },
});

// The tomba adapter of the email-finder port (README.md): Tomba's Email Finder, on the free plan's
// 25 searches a month. One GET with the domain, the first name and the last name, and nothing else;
// the key and the secret in their two headers. Tomba's address comes with its own check,
// `verification.status` and the domain's `accept_all`, mapped onto the five verdicts, accept-all
// never valid (README.md "Mapping"). No SDK, no retry: enrichment asks the next finder on any error.
import { z } from "zod";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { foundOf, missingVariable, shaped } from "../answer.ts";
import { emailFinderPort } from "../port.ts";
import { tombaClient } from "./client.ts";
import { tombaConfig } from "./config.ts";
import { KEY_VARIABLE, SECRET_VARIABLE, TIMEOUT_MS, TOMBA_ORIGIN, VERDICTS } from "./constants.ts";

export type TombaOptions = {
  /** Tomba's fixed host; a test's server on 127.0.0.1. */
  readonly origin: string;
  readonly key: string;
  readonly secret: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

/** The parts of Tomba's answer the adapter reads; every other field (the person, the sources) is left unread. */
const tombaAnswer = z.object({
  data: z
    .object({
      email: z.string().nullish(),
      accept_all: z.boolean().nullish(),
      verification: z.object({ status: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

/** The adapter on `origin` with the key and the secret: what create() returns on Tomba's host. */
export function tombaEmailFinder(
  options: TombaOptions,
): PortImplementation<typeof emailFinderPort> {
  const { origin, key, secret, timeoutMs = TIMEOUT_MS, now = Date.now } = options;
  const client = tombaClient(origin, { key, secret }, timeoutMs, now);
  return {
    findEmail: async (input) => {
      const { data } = shaped(tombaAnswer, await client(input));
      const verdict = data?.accept_all ? "catch_all" : VERDICTS[data?.verification?.status ?? ""];
      return foundOf(data?.email, verdict);
    },
  };
}

export const tombaAdapter = defineAdapter(emailFinderPort, {
  name: "tomba",
  requires: [KEY_VARIABLE, SECRET_VARIABLE],
  allowance: tombaConfig.TOMBA_ALLOWANCE,
  create: () => {
    const { TOMBA_KEY: key, TOMBA_SECRET: secret } = tombaConfig;
    if (!key) throw missingVariable(KEY_VARIABLE, "tomba");
    if (!secret) throw missingVariable(SECRET_VARIABLE, "tomba");
    return tombaEmailFinder({ origin: TOMBA_ORIGIN, key, secret });
  },
});

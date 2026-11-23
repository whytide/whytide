// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8;
// README "How it works"): the sources' lists, in the order they are asked, and the tick's, the
// batch's and the company's pace; the website source's pages and its model (gamma-en-065); the
// country namer's model (gamma-en-075); the email lookup's price, sources, bound and UK and EU switch
// (gamma-en-080); the days a verified address is trusted and a lookup that found none waits
// (env-settings-b, README "Settings"); the switch of the lookup at find (gamma-wr-070). A list names sources (domain/sources/), each once, separated by commas, spaces
// around a name ignored; a name that cannot run is left out at start, never an error
// (docs/runbook.md).

import { defineConfig } from "@whytide/platform";
import { ADAPTER_NAME } from "@whytide/providers";
import { z } from "zod";
import { COMPANY_DATA } from "./domain/constants.ts";
import { EMAIL_FINDER, EMAIL_VALID_DAYS, NOT_FOUND_RETRY_DAYS } from "./domain/lookup/constants.ts";

/** Source names separated by commas, each once, trimmed, an empty one dropped; none, `fallback`. */
export function sourceList(fallback: readonly string[]) {
  return z
    .string()
    .optional()
    .transform((value, context): readonly string[] => {
      const names = (value ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");
      // Spaces or commas only are as empty as an empty setting: unset.
      if (names.length === 0) return Object.freeze([...fallback]);
      if (!names.every((name) => ADAPTER_NAME.test(name)) || new Set(names).size !== names.length) {
        context.addIssue({
          code: "custom",
          message: "source names separated by commas, each once",
        });
        return z.NEVER;
      }
      return Object.freeze(names);
    });
}

export const settings = defineConfig("modules/enrichment", {
  /** The company's sources in the order asked; `company-data` expands to PROVIDER_COMPANY_DATA's. */
  ENRICHMENT_COMPANY_SOURCES: sourceList([COMPANY_DATA]),
  /** The person's sources in the order asked (gamma-en-075); none by default. */
  ENRICHMENT_PERSON_SOURCES: sourceList([]),
  /** Minutes between two ticks of the schedule enrichment.tick. */
  ENRICHMENT_TICK_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  /** The held leads one batch takes at most, oldest first. */
  ENRICHMENT_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  /** Days a company enriched for a new lead is not asked again for the next one. */
  ENRICHMENT_COMPANY_RETRY_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Days until a company's fact is asked again by its next run (gamma-rf-020); 0, never. */
  ENRICHMENT_FACT_DAYS: z.coerce.number().int().min(0).max(3650).default(180),
  /** Days a verified address is trusted before it is checked again (RB-7.3.3), 1 or more. */
  ENRICHMENT_EMAIL_VALID_DAYS: z.coerce.number().int().positive().default(EMAIL_VALID_DAYS.default),
  /** Days after a lookup that found no usable address before that person is looked up again. */
  ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(NOT_FOUND_RETRY_DAYS.default),
  /** The pages the `website` source reads of a company's site at most, its home page included. */
  ENRICHMENT_SITE_MAX_PAGES: z.coerce.number().int().min(1).max(10).default(5),
  /** The model of enrichment.read-company-site; unset, the LLM adapter's default. */
  AI_MODEL_ENRICHMENT_READ_COMPANY_SITE: z.string().min(1).optional(),
  /** The country namer's model (agents/name-country/README.md, gamma-en-075); unset, the port's first. */
  AI_MODEL_ENRICHMENT_NAME_COUNTRY: z.string().min(1).optional(),
  /** Credits per verified email address (gamma-en-080); credits' PRICE_ENRICHMENT_WORK_EMAIL overrides it. */
  ENRICHMENT_CREDITS_PER_EMAIL: z.coerce.number().int().min(0).max(100).default(1),
  /** The email sources in the order asked; `email-finder` expands to PROVIDER_EMAIL_FINDER's. */
  ENRICHMENT_EMAIL_SOURCES: sourceList([EMAIL_FINDER]),
  /** The most candidates one lookup verifies, across every source. */
  ENRICHMENT_EMAIL_MAX_CANDIDATES: z.coerce.number().int().min(1).max(5).default(3),
  /**
   * Personal addresses of leads in the UK, the EU and the EEA, or with no known country, used
   * without the person's consent: off by default (the owner's decision of 2026-11-13).
   */
  ENRICHMENT_PERSONAL_EMAIL_EU_UK: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /**
   * An email lookup asked for each lead a research source finds (gamma-wr-070), with the address a
   * page printed with the person to verify first; on by default. Off, none is asked and a printed
   * address stays the person's key only.
   */
  ENRICHMENT_LOOKUP_AT_FIND: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

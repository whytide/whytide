// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): how
// many pages the website fetch reads (README "The website fetch"), the drafter's model, and how many
// documents a Draft takes and how large each file may be (README "Settings"). The drafter's task file
// imports this file too: it imports nothing of the module but domain/constants.ts, which imports
// nothing. The screen never imports it: the documents' limits reach it in the record's answer.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import { DOCUMENT_BYTES, DOCUMENT_FILES, FETCH_MAX_PAGES } from "./domain/constants.ts";

export const settings = defineConfig("modules/onboarding", {
  /** The pages a website fetch reads at most, the home page included. */
  ONBOARDING_FETCH_MAX_PAGES: z.coerce.number().int().min(1).max(FETCH_MAX_PAGES).default(5),
  /** The drafter's model as the LLM port names it; unset, the port's first model. */
  AI_MODEL_ONBOARDING_DRAFT_COMPANY_KNOWLEDGE: z.string().min(1).optional(),
  /** The documents one Draft takes at most, from the script or the screen; 1 or more, no maximum. */
  ONBOARDING_MAX_FILES: z.coerce.number().int().positive().default(DOCUMENT_FILES.default),
  /** The bytes of one document's file at most, checked before it is read; 1 or more, no maximum. */
  ONBOARDING_MAX_FILE_BYTES: z.coerce.number().int().positive().default(DOCUMENT_BYTES.default),
});

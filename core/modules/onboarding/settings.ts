// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): how
// many pages the website fetch reads (README "The website fetch") and the drafter's model. The
// drafter's task file imports this file too: it imports nothing of the module.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const settings = defineConfig("modules/onboarding", {
  /** The pages a website fetch reads at most, the home page included. */
  ONBOARDING_FETCH_MAX_PAGES: z.coerce.number().int().min(1).max(10).default(5),
  /** The drafter's model as the LLM port names it; unset, the port's first model. */
  AI_MODEL_ONBOARDING_DRAFT_COMPANY_KNOWLEDGE: z.string().min(1).optional(),
});

// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): the
// drafter's model (README "The draft"). The drafter's task file imports this file too: it imports
// nothing of the module.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const settings = defineConfig("modules/icp", {
  /** The drafter's model as the LLM port names it; unset, the port's first model. */
  AI_MODEL_ICP_DRAFT_PROFILE: z.string().min(1).optional(),
});

// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): the
// drafter's model (README "The draft") and the audiences' limit (README "Settings"), read once as
// the module loads, so that a value that is not an integer of 1 or more stops the start with
// config_invalid. The drafter's task file imports this file too: it imports nothing of the module
// but domain/constants.ts, which imports nothing. The screen never imports it: it shows the limit
// the audiences' list answers.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import { AUDIENCES_PER_WORKSPACE } from "./domain/constants.ts";

export const settings = defineConfig("modules/icp", {
  /** The drafter's model as the LLM port names it; unset, the port's first model. */
  AI_MODEL_ICP_DRAFT_PROFILE: z.string().min(1).optional(),
  /** The audiences of one workspace, its default included, 1 or more (README "Settings"). */
  ICP_MAX_AUDIENCES_PER_WORKSPACE: z.coerce
    .number()
    .int()
    .positive()
    .default(AUDIENCES_PER_WORKSPACE.default),
});

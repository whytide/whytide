// qualification's block of deploy/.env.example (README.md "Settings"): the assessment agent's model,
// named by the ai package's convention AI_MODEL_<MODULE>_<AGENT>; unset, the LLM port's first model.
// The agent's task file reads it, so this file imports nothing of the module.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const qualificationConfig = defineConfig("modules/qualification", {
  AI_MODEL_QUALIFICATION_ASSESS_FIT: z.string().min(1).optional(),
});

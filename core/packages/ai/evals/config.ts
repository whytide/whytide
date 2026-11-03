// The evals' variable, in the packages/ai block of deploy/.env.example (README.md "Evals"): 1 runs the
// cases on the model PROVIDER_LLM names, at its price; 0, the default and the pipeline's, on the LLM
// fake with each case's scripted answers.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const evalConfig = defineConfig("packages/ai", {
  EVAL_LIVE: z.enum(["0", "1"]).default("0"),
});

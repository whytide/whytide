// The wrapper's variable, in the packages/ai block of deploy/.env.example (README.md "Decision
// records"): the days a decision record keeps its raw prompt and output; alpha-p1-145's purge nulls
// them after that.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const callConfig = defineConfig("packages/ai", {
  AI_RAW_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
});

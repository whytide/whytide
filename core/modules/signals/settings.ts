// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8). A
// kind's own settings sit in its folder: sources/post_engagers/config.ts, the same block.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const settings = defineConfig("modules/signals", {
  SIGNALS_MAX_ENABLED_SOURCES: z.coerce.number().int().positive().default(10),
  /** The pages a run reserves credits for before it reads (README.md "Runs"). */
  SIGNALS_ESTIMATED_PAGES: z.coerce.number().int().positive().default(4),
});

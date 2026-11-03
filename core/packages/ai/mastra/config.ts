// The Mastra instance's variable, in the packages/ai block of deploy/.env.example (README "The
// Mastra instance").
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const mastraConfig = defineConfig("packages/ai", {
  /** The schema of Mastra's storage; the migration ai_mastra_schema creates `mastra` for `app`. */
  MASTRA_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default("mastra"),
});

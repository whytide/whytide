// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8),
// beside config.ts's model: how many leads a batch reads and how often the tick starts batches
// (README "The batch").
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const settings = defineConfig("modules/qualification", {
  /** The leads one batch reads at most, oldest first. */
  QUALIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  /** Minutes between two ticks of the schedule qualification.batch_tick. */
  QUALIFICATION_SCHEDULE_MINUTES: z.coerce.number().int().min(1).max(60).default(2),
});

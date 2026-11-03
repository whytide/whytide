// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8). A
// kind's own settings sit in its folder: sources/post_engagers/config.ts, the same block.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import { CREDITS_PER_ENGAGER } from "./domain/constants.ts";

const { default: perEngager, min, max } = CREDITS_PER_ENGAGER;

export const settings = defineConfig("modules/signals", {
  SIGNALS_MAX_ENABLED_SOURCES: z.coerce.number().int().positive().default(10),
  /** The pages a run started before beta-p1-090 reserves credits for (README.md "Runs"). */
  SIGNALS_ESTIMATED_PAGES: z.coerce.number().int().positive().default(4),
  /** The credits of one engager's profile read, signals.engager's (README.md "Settings"). */
  SIGNALS_CREDITS_PER_ENGAGER: z.coerce.number().int().min(min).max(max).default(perEngager),
});

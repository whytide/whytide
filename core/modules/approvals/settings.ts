// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8):
// how long a pending item waits before it needs attention, how far ahead of its due time "Up next"
// opens a step, which campaigns' queue reads as queueWindowHours through index.ts, and the largest
// small edit (env-settings-a; README.md "Settings"), read once as the module loads, so that a value
// off its range stops the start with config_invalid. The screens never import this file.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import {
  NEEDS_ATTENTION_AFTER_DAYS,
  QUEUE_WINDOW_HOURS,
  SMALL_EDIT_MAX_RATIO,
} from "./domain/items/constants.ts";

export const settings = defineConfig("modules/approvals", {
  /** Days pending before an item needs attention, 1 or more, no maximum (README.md "Settings"). */
  APPROVALS_NEEDS_ATTENTION_AFTER_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(NEEDS_ATTENTION_AFTER_DAYS.default),
  /** Hours ahead of its due time a step enters "Up next", 1 or more, no maximum (README.md). */
  APPROVALS_QUEUE_WINDOW_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(QUEUE_WINDOW_HOURS.default),
  /** The largest edit ratio that is a small edit, above 0 and at most 1 (README.md "Settings"). */
  APPROVALS_SMALL_EDIT_MAX_RATIO: z.coerce
    .number()
    .gt(0)
    .max(1)
    .default(SMALL_EDIT_MAX_RATIO.default),
});

/** APPROVALS_QUEUE_WINDOW_HOURS as configured: campaigns' queue opens the steps due within it. */
export const queueWindowHours = settings.APPROVALS_QUEUE_WINDOW_HOURS;

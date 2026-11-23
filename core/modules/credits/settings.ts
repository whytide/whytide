// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): the
// fixed plan the seeder writes at the api's start (README "The seeder"), then the credit alerts'
// thresholds and how long a price rise is announced (README "Settings"), read once as the module
// loads, so that a value off its form stops the start with config_invalid naming it.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import {
  ALERT_THRESHOLD_PATTERN,
  ALERT_THRESHOLD_RANGE,
  ALERT_THRESHOLDS,
} from "./domain/alerts/constants.ts";
import { PRICE_NOTICE_DAYS } from "./domain/constants.ts";

const { min, max } = ALERT_THRESHOLD_RANGE;

/**
 * Whole percents from 1 to 100 separated by commas, spaces around one ignored, at least one, each
 * once; lowest first, whatever their order. Unset, ALERT_THRESHOLDS's default.
 */
function thresholds() {
  return z
    .string()
    .optional()
    .transform((value, context): readonly number[] => {
      if (value === undefined) return Object.freeze([...ALERT_THRESHOLDS.default]);
      const parts = value.split(",").map((part) => part.trim());
      const percents = parts.map(Number);
      const whole = parts.every((part) => ALERT_THRESHOLD_PATTERN.test(part));
      const inRange = percents.every((percent) => percent >= min && percent <= max);
      if (!whole || !inRange || new Set(percents).size !== percents.length) {
        const message = `whole percents from ${min} to ${max} separated by commas, each once`;
        context.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return Object.freeze(percents.sort((a, b) => a - b));
    });
}

export const settings = defineConfig("modules/credits", {
  CREDITS_MONTHLY_ALLOWANCE: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(10_000_000),
  CREDITS_PLAN_CODE: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,39}$/)
    .default("self_hosted"),
  /** The shares of a period's granted credits, in percent, that each send one alert mail a period. */
  CREDITS_ALERT_THRESHOLDS: thresholds(),
  /** The days a price rise is announced before it applies, 1 or more, no maximum. */
  CREDITS_PRICE_CHANGE_NOTICE_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(PRICE_NOTICE_DAYS.default),
});

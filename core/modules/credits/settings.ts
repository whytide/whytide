// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): the
// fixed plan the seeder writes at the api's start (README "The seeder").
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

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
});

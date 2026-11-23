// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): the
// email the smoke test signs in with (tests/smoke.ts), which it invites itself, and how long an
// invite stays open (README "Settings"), read once as the module loads, so that a value that is not
// an integer of 1 or more stops the start with config_invalid. The screens never import this file:
// they show the days the invites' list answers.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import { INVITE_OPEN_DAYS } from "./domain/constants.ts";

export const settings = defineConfig("modules/identity", {
  SMOKE_EMAIL: z.email().default("smoke@example.test"),
  /** The days an invite stays open after it is made or renewed, 1 or more, no maximum. */
  IDENTITY_INVITE_TTL_DAYS: z.coerce.number().int().positive().default(INVITE_OPEN_DAYS.default),
});

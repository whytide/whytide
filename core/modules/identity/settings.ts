// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): the
// email the smoke test signs in with (tests/smoke.ts), which it invites itself.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const settings = defineConfig("modules/identity", {
  SMOKE_EMAIL: z.email().default("smoke@example.test"),
});

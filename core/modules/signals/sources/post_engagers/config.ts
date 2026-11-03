// The post_engagers kind's setting, in the signals block of deploy/.env.example: a kind's settings
// live in its folder, so adding a kind changes no shared file (README.md "Adding a kind").
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const postEngagersConfig = defineConfig("modules/signals", {
  SIGNALS_POST_ENGAGERS_LOOKBACK_DAYS: z.coerce.number().int().positive().default(30),
});

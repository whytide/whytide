// The post_engagers kind's setting, in the signals block of deploy/.env.example: a kind's settings
// live in its folder, so adding a kind changes no shared file (README.md "Adding a kind"); at most
// LOOKBACK_DAYS_MAX, or the api and the worker stop at start (README.md "Settings").
import { defineConfig } from "@whytide/platform";
import { lookbackSetting } from "../_contract.ts";

/** The lookback's schema, which a test reads values through. */
export const postEngagersLookback = lookbackSetting(30);
export const postEngagersConfig = defineConfig("modules/signals", {
  SIGNALS_POST_ENGAGERS_LOOKBACK_DAYS: postEngagersLookback,
});

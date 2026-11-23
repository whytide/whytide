// The creator_engagement kind's setting, in the signals block of deploy/.env.example (README.md
// "Settings"): at most LOOKBACK_DAYS_MAX, or the api and the worker stop at start.
import { defineConfig } from "@whytide/platform";
import { lookbackSetting } from "../_contract.ts";

/** The lookback's schema, which a test reads values through. */
export const creatorLookback = lookbackSetting(14);
export const creatorConfig = defineConfig("modules/signals", {
  SIGNALS_CREATOR_LOOKBACK_DAYS: creatorLookback,
});

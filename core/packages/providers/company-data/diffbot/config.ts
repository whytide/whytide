// The diffbot adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example. The token is optional here, so that loading the adapter never throws, and
// checked by create(); the allowance is the free plan's, 400 companies a month, unless set.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { allowance } from "../../_pattern/index.ts";
import { DEFAULT_ALLOWANCE } from "./constants.ts";

export const diffbotConfig = defineConfig("packages/providers", {
  DIFFBOT_TOKEN: secret(z.string().optional()),
  DIFFBOT_ALLOWANCE: allowance().default(DEFAULT_ALLOWANCE),
});

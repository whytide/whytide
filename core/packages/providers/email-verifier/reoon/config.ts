// The reoon adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example. The key is optional here, so that loading the adapter never throws, and
// checked by create(); the allowance is the free plan's, 20 checks a day, unless set.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { allowance } from "../../_pattern/index.ts";
import { DEFAULT_ALLOWANCE } from "./constants.ts";

export const reoonConfig = defineConfig("packages/providers", {
  REOON_API_KEY: secret(z.string().optional()),
  REOON_ALLOWANCE: allowance().default(DEFAULT_ALLOWANCE),
});

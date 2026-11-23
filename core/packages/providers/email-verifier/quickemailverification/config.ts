// The quickemailverification adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example. The key is optional here, so that loading the adapter never throws, and
// checked by create(); the allowance is the free plan's, 100 checks a day, unless set.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { allowance } from "../../_pattern/index.ts";
import { DEFAULT_ALLOWANCE } from "./constants.ts";

export const quickEmailVerificationConfig = defineConfig("packages/providers", {
  QUICKEMAILVERIFICATION_API_KEY: secret(z.string().optional()),
  QUICKEMAILVERIFICATION_ALLOWANCE: allowance().default(DEFAULT_ALLOWANCE),
});

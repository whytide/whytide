// The verifalia adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example: a user made for Whytide with verification rights only, by HTTP basic auth.
// Both are optional here, so that loading the adapter never throws, and checked by create(); the
// allowance is the free plan's, 25 checks a day, unless set.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { allowance } from "../../_pattern/index.ts";
import { DEFAULT_ALLOWANCE } from "./constants.ts";

export const verifaliaConfig = defineConfig("packages/providers", {
  VERIFALIA_USERNAME: z.string().optional(),
  VERIFALIA_PASSWORD: secret(z.string().optional()),
  VERIFALIA_ALLOWANCE: allowance().default(DEFAULT_ALLOWANCE),
});

// The pdl adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example. The key is optional here, so that loading the adapter never throws, and
// checked by create(); the allowance is the free plan's, 100 a month, and the least likelihood of a
// match 6 of 10, unless set.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { allowance } from "../../_pattern/index.ts";
import { DEFAULT_ALLOWANCE, LIKELIHOOD } from "./constants.ts";

export const pdlConfig = defineConfig("packages/providers", {
  PDL_API_KEY: secret(z.string().optional()),
  PDL_ALLOWANCE: allowance().default(DEFAULT_ALLOWANCE),
  PDL_MIN_LIKELIHOOD: z.coerce
    .number()
    .int()
    .min(LIKELIHOOD.min)
    .max(LIKELIHOOD.max)
    .default(LIKELIHOOD.default),
});

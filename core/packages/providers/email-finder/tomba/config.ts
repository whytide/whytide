// The tomba adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example. The key and the secret are optional here, so that loading the adapter never
// throws, and checked by create(); the allowance is the free plan's, 25 a month, unless set.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { allowance } from "../../_pattern/index.ts";
import { DEFAULT_ALLOWANCE } from "./constants.ts";

export const tombaConfig = defineConfig("packages/providers", {
  TOMBA_KEY: secret(z.string().optional()),
  TOMBA_SECRET: secret(z.string().optional()),
  TOMBA_ALLOWANCE: allowance().default(DEFAULT_ALLOWANCE),
});

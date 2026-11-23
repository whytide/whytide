// The snov adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example. The client's id and secret are optional here, so that loading the adapter
// never throws, and checked by create(); the allowance is the free plan's, 50 a month, unless set.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { allowance } from "../../_pattern/index.ts";
import { DEFAULT_ALLOWANCE } from "./constants.ts";

export const snovConfig = defineConfig("packages/providers", {
  SNOV_CLIENT_ID: secret(z.string().optional()),
  SNOV_CLIENT_SECRET: secret(z.string().optional()),
  SNOV_ALLOWANCE: allowance().default(DEFAULT_ALLOWANCE),
});

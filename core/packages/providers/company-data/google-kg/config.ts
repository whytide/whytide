// The google-kg adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example: the Google Cloud API key with the Knowledge Graph Search API on, a secret, and
// the free allowance, 100,000 calls a day unless set. The key is optional here, so that reading the
// block never throws for it: create() requires it.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { allowance } from "../../_pattern/index.ts";
import { API_KEY, FREE_ALLOWANCE } from "./constants.ts";

export const googleKgConfig = defineConfig("packages/providers", {
  GOOGLE_KG_API_KEY: secret(z.string().regex(API_KEY, "printable, no space").optional()),
  GOOGLE_KG_ALLOWANCE: allowance().default(FREE_ALLOWANCE),
});

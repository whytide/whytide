// The companies-house adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example: the API key, a secret, and the free allowance, empty, since the API has no
// quota but its rate limit. The key is optional here, so that reading the block never throws for it:
// create() requires it.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { allowance } from "../../_pattern/index.ts";
import { API_KEY } from "./constants.ts";

export const companiesHouseConfig = defineConfig("packages/providers", {
  COMPANIES_HOUSE_API_KEY: secret(
    z.string().regex(API_KEY, "printable, no space or colon").optional(),
  ),
  COMPANIES_HOUSE_ALLOWANCE: allowance(),
});

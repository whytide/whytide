// The Brave adapter's variables (README.md "Variables"), in the providers block of deploy/.env.example:
// its key, a secret, and its free allowance. Optional here, so that importing the adapter never
// throws on an empty key: create() checks it. BRAVE_ALLOWANCE is read with allowance(), so that a
// value off its form fails at start.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { allowance } from "../../_pattern/index.ts";

export const braveConfig = defineConfig("packages/providers", {
  BRAVE_API_KEY: secret(z.string().optional()),
  BRAVE_ALLOWANCE: allowance(),
});

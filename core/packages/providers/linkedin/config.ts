// PROVIDER_LINKEDIN (README.md "Adapters"): `fake` in development and tests, `unipile` on the vendor.
import { defineConfig } from "@whytide/platform";
import { providerSelector } from "../_pattern/index.ts";

export const linkedinConfig = defineConfig("packages/providers", {
  PROVIDER_LINKEDIN: providerSelector(),
});

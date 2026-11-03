// PROVIDER_APP_MAIL (README.md "Adapters"): the adapter the app's mail goes through, `smtp` in
// development, to the shared stack's Mailpit, and in production; `fake` in module tests.
import { defineConfig } from "@whytide/platform";
import { providerSelector } from "../_pattern/index.ts";

export const appMailConfig = defineConfig("packages/providers", {
  PROVIDER_APP_MAIL: providerSelector(),
});

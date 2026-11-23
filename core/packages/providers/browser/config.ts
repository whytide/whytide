// PROVIDER_BROWSER (README.md "Adapters"): the adapter pages are rendered on, `playwright` on a server
// that runs the browser service, `fake` in development and tests. Empty means no browser: the caller
// keeps the plain fetch's page (gamma-en-065). providerSelector() is optional and defineConfig reads
// an empty value as unset, so the empty default needs nothing more.
import { defineConfig } from "@whytide/platform";
import { providerSelector } from "../_pattern/index.ts";

export const browserConfig = defineConfig("packages/providers", {
  PROVIDER_BROWSER: providerSelector(),
});

// PROVIDER_EMAIL_VERIFIER (README.md "Adapters"): the adapters an address is checked on,
// comma-separated, in the order enrichment gives them their turns; `fake` in development and tests,
// empty for none. providerList() reads an empty value as none, so the empty default needs nothing more.
import { defineConfig } from "@whytide/platform";
import { providerList } from "../_pattern/index.ts";

export const emailVerifierConfig = defineConfig("packages/providers", {
  PROVIDER_EMAIL_VERIFIER: providerList(),
});

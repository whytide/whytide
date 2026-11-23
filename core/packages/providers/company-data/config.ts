// PROVIDER_COMPANY_DATA (README.md "Adapters"): the adapters a company's facts are looked up on,
// comma-separated, in the order enrichment asks them; `fake` in development and tests, empty for
// none. providerList() reads an empty value as none, so the empty default needs nothing more.
import { defineConfig } from "@whytide/platform";
import { providerList } from "../_pattern/index.ts";

export const companyDataConfig = defineConfig("packages/providers", {
  PROVIDER_COMPANY_DATA: providerList(),
});

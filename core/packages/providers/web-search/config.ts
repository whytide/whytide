// PROVIDER_WEB_SEARCH (README.md "Adapters"): the adapters a web search runs on, comma-separated, in
// the order the caller asks them; `fake` in development and tests, `brave` in production, empty for
// none. providerList() reads an empty value as none, so the empty default needs nothing more.
import { defineConfig } from "@whytide/platform";
import { providerList } from "../_pattern/index.ts";

export const webSearchConfig = defineConfig("packages/providers", {
  PROVIDER_WEB_SEARCH: providerList(),
});

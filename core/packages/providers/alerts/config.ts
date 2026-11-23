// PROVIDER_ALERTS (README.md "Adapters"): the adapter the team channel's alerts go through, `webhook`
// on a server with a team channel, `fake` in tests. Empty means no team channel: nothing binds the
// port, and its caller sends nothing. providerSelector() is optional and defineConfig reads an empty
// value as unset, so the empty default needs nothing more.
import { defineConfig } from "@whytide/platform";
import { providerSelector } from "../_pattern/index.ts";

export const alertsConfig = defineConfig("packages/providers", {
  PROVIDER_ALERTS: providerSelector(),
});

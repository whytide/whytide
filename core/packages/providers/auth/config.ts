// PROVIDER_AUTH (README.md "Selecting the adapter"): `better-auth`, or `fake` in the api's tests.
import { defineConfig } from "@whytide/platform";
import { providerSelector } from "../_pattern/index.ts";

export const authConfig = defineConfig("packages/providers", { PROVIDER_AUTH: providerSelector() });

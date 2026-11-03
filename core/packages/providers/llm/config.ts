// PROVIDER_LLM (README.md "A port"): the adapter folder the LLM port runs on, `fake` in development
// and tests. A host awaits getAdapter(llmPort, llmConfig.PROVIDER_LLM) at start.
import { defineConfig } from "@whytide/platform";
import { providerSelector } from "../_pattern/index.ts";

export const llmConfig = defineConfig("packages/providers", { PROVIDER_LLM: providerSelector() });

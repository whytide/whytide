// PROVIDER_FILES (../README.md "A port"): the adapter the files port runs on, `s3` against the shared
// stack's MinIO in development, `fake` where a test needs no store. port.ts exports it for the hosts.
import { defineConfig } from "@whytide/platform";
import { providerSelector } from "../_pattern/index.ts";

export const filesConfig = defineConfig("packages/providers", {
  PROVIDER_FILES: providerSelector(),
});

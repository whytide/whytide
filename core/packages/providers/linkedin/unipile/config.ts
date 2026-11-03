// The Unipile adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example. All optional here, so that importing the package never throws: create()
// checks the three it cannot run without, and createHostedAuthLink the notify address. Both URLs
// are https: a test hands its loopback address to unipileLinkedin() directly.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";

export const unipileConfig = defineConfig("packages/providers", {
  UNIPILE_BASE_URL: z.url({ protocol: /^https$/ }).optional(),
  UNIPILE_API_KEY: secret(z.string().optional()),
  UNIPILE_WEBHOOK_SECRET: secret(z.string().optional()),
  UNIPILE_NOTIFY_URL: z.url({ protocol: /^https$/ }).optional(),
});

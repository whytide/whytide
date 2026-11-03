// The platform's own block of deploy/.env.example, read once at import: the environment the hosts
// run as, pino's level, the collector address telemetry exports to while it is set, and the locale
// when neither the user's setting nor the browser names one. APP_ENV has no default: a server that
// lost it would otherwise run as development, without the Secure cookie and with vendor causes kept.
import { z } from "zod";
import { defineConfig } from "./define.ts";

/** A BCP 47 language tag as Intl reads it: `en`, `en-GB`, `zh-Hant`. */
function isLanguageTag(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

export const platformConfig = defineConfig("packages/platform", {
  APP_ENV: z.enum(["development", "test", "production"], {
    error: "required: development, test or production",
  }),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  DEFAULT_LOCALE: z
    .string()
    .refine(isLanguageTag, { error: "a BCP 47 language tag such as en or en-GB" })
    .default("en"),
});

// The request protections' variables, in the api's block of deploy/.env.example (docs/security.md):
// Redis, which holds the rate limits' windows, the three limits, the origins a state-changing
// request with a session cookie may come from, and the proxies whose X-Forwarded-For is believed.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";

/** An origin: a scheme, a host and a port, nothing after them but one slash; read as a browser sends it. */
const origin = z
  .url({ protocol: /^https?$/ })
  .refine((value) => /^https?:\/\/[^/?#@]+\/?$/i.test(value), "an origin: scheme, host and port")
  .transform((value) => new URL(value).origin);

export const protectionConfig = defineConfig("apps/api", {
  // A password may sit in the URL in production.
  REDIS_URL: secret(z.url({ protocol: /^rediss?$/ }).default("redis://127.0.0.1:6379")),
  /** Every key starts with it: the slice's in development, so slices never meet. */
  REDIS_PREFIX: z.string().default(""),
  RATE_LIMIT_WORKSPACE_PER_MIN: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_AUTH_PER_IP_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_WEBHOOK_PER_IP_PER_MIN: z.coerce.number().int().positive().default(120),
  APP_PUBLIC_ORIGIN: origin.optional(),
  /** Accepted under APP_ENV=development only: the web's development server. */
  WEB_DEV_ORIGIN: origin.optional(),
  /** Express's `trust proxy`: names and addresses, comma-separated; Caddy's address in production. */
  TRUST_PROXY: z.string().trim().min(1).default("loopback,linklocal,uniquelocal"),
});

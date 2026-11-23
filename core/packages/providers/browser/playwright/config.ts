// The playwright adapter's variable (README.md "Variables"), in the providers block of
// deploy/.env.example: the browser service's endpoint, ws://browser:3000/ in Compose, no secret. Read
// when the adapter starts, so that a host on the fake never reads it; optional here, so that reading
// never throws, and checked by create().
import { defineConfig, type Env } from "@whytide/platform";
import { z } from "zod";

export function playwrightConfig(env: Env = process.env) {
  // The block as a literal: env:check reads the call, never runs it.
  return defineConfig("packages/providers", { BROWSER_WS_URL: z.string().optional() }, env);
}

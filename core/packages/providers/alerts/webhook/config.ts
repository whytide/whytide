// The webhook adapter's variable (README.md "Variables"), in the providers block of
// deploy/.env.example: the team channel's incoming webhook URL, a secret, since it holds the channel's
// token. Read when the adapter starts, so that a host without a team channel never reads it; optional
// here, so that reading never throws, and checked by create().
import { defineConfig, type Env, secret } from "@whytide/platform";
import { z } from "zod";

export function webhookConfig(env: Env = process.env) {
  // The block as a literal: env:check reads the call, never runs it.
  return defineConfig(
    "packages/providers",
    { ALERTS_WEBHOOK_URL: secret(z.string().optional()) },
    env,
  );
}

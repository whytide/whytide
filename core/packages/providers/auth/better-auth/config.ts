// The Better Auth adapter's settings (README.md "Variables"), read when the adapter starts, so that
// a host on the fake needs neither. Better Auth also reads variables of its own, which would win
// over these or add to them (a second secret, another base URL, more trusted origins, telemetry):
// the adapter refuses to start while any BETTER_AUTH_* variable is set ("Vendor and terms").
import { randomBytes } from "node:crypto";
import { AppError, defineConfig, type Env, platformConfig, secret } from "@whytide/platform";
import { z } from "zod";

const BLOCK = "packages/providers";

export type BetterAuthSettings = { readonly secret: string; readonly baseURL: string };

export function betterAuthSettings(env: Env = process.env): BetterAuthSettings {
  const vendor = Object.keys(env).filter((name) => name.startsWith("BETTER_AUTH_") && env[name]);
  const refuse = (variables: string[]) =>
    new AppError("config_invalid", { details: { block: BLOCK, variables } });
  if (vendor.length) {
    throw refuse(vendor.sort().map((name) => `${name}: Better Auth's own, refused; unset it`));
  }
  // The block as a literal: env:check reads the call, never runs it.
  const config = defineConfig(
    "packages/providers",
    {
      AUTH_SECRET: secret(z.string().min(32).optional()),
      AUTH_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    },
    env,
  );
  const production = platformConfig.APP_ENV === "production";
  if (production && (!config.AUTH_SECRET || !config.AUTH_BASE_URL)) {
    throw refuse(["AUTH_SECRET, AUTH_BASE_URL: both required under APP_ENV=production"]);
  }
  // API_PORT is the api's (its config block): the default origin of a laptop's links.
  const port = env.API_PORT || "3001";
  return {
    // Outside production an empty AUTH_SECRET is a random one: sessions end when the process does.
    secret: config.AUTH_SECRET ?? randomBytes(32).toString("base64url"),
    baseURL: new URL(config.AUTH_BASE_URL ?? `http://127.0.0.1:${port}`).origin,
  };
}

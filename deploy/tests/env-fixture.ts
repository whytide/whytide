// The production example filled as an operator fills it (README.md "Production"), for
// deploy-check.test.ts and production.test.ts. Every secret is made here, at random, at each run:
// none is written in the repository.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const deployDir = join(import.meta.dirname, "..");
export const readDeployFile = (name: string) => readFileSync(join(deployDir, name), "utf8");

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
/** A connection string to the database app, built so that no URL with a password sits in the code. */
function databaseUrl(role: string): string {
  const url = new URL("postgresql://postgres:5432/app");
  url.username = role;
  url.password = hex(24);
  return url.href;
}

/** The values an operator fills: the secrets a server needs, each fresh. */
function secrets(): Record<string, string> {
  return {
    DEV_POSTGRES_PASSWORD: hex(24),
    DEV_MINIO_ROOT_PASSWORD: hex(24),
    APP_MASTER_KEY: randomBytes(32).toString("base64"),
    DATABASE_URL_OWNER: databaseUrl("whytide_owner"),
    DATABASE_URL: databaseUrl("whytide_app"),
    DATABASE_URL_BILLING_WRITER: databaseUrl("whytide_billing_writer"),
    AUTH_SECRET: hex(32),
    HASH_SALT: hex(32),
    UNIPILE_API_KEY: hex(24),
    UNIPILE_WEBHOOK_SECRET: hex(24),
    LLM_ANTHROPIC_API_KEY: hex(24),
  };
}

/** .env.production.example with its secrets filled, then `overrides` in place or added at the end. */
export function filledProductionEnv(overrides: Record<string, string> = {}): string {
  const values = new Map(Object.entries({ ...secrets(), ...overrides }));
  const lines = readDeployFile(".env.production.example")
    .split("\n")
    .map((line) => {
      const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
      if (key === undefined || !values.has(key)) return line;
      const value = values.get(key);
      values.delete(key);
      return `${key}=${value}`;
    });
  return `${[...lines, ...[...values].map(([key, value]) => `${key}=${value}`)].join("\n")}\n`;
}

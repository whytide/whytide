// A fixture of tests/config.test.ts: two config blocks whose variables disagree with the
// .env.example next to them, so env:check has something to find. Parsed, never imported.
import { z } from "zod";
import { defineConfig, secret } from "../../../../../../config/index.ts";

export const platformFixture = defineConfig(
  "packages/platform",
  { A_URL: z.url(), B_SECRET: z.string().optional() },
  {},
);
export const sampleFixture = defineConfig(
  "modules/sample",
  {
    C_MODE: z.string().default("strict"),
    D_MISSING: z.string().optional(),
    F_TOKEN: secret(z.string().optional()),
    REDIS_URL: z.string().optional(),
  },
  {},
);

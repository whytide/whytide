// Prisma 7 reads its configuration from here, not from the schema: the schema folder, the migrations
// folder and the owner's connection string, which migrations use (docs/rules/coding.md §5). The CLI
// reads the environment of its process only, so .env.local at the repository root is loaded first;
// an existing variable wins, which is how the GitLab job and a deployment pass theirs.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "prisma/config";

const envLocal = resolve(import.meta.dirname, "..", "..", "..", ".env.local");
if (existsSync(envLocal)) process.loadEnvFile(envLocal);
// The CLI phones checkpoint.prisma.io for update notices and usage data unless this is set. The
// package's commands set it for their child process (src/migrate.ts); this covers `pnpm exec prisma`.
process.env.CHECKPOINT_DISABLE ??= "1";

export default defineConfig({
  schema: "prisma/schema",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL_OWNER },
});

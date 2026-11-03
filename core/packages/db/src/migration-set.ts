// A migration set other than the package's own: a temporary folder under .tmp/ (git-ignored) and a
// prisma.config.ts that points Prisma at it, so runMigrations() applies the real migrations plus a
// fixture, or a previous release's set, the way the api host applies the real ones. The migration
// checks (migrate-check.ts) and the test helpers (testing/) build on these two functions.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./paths.ts";

/** A fresh folder `.tmp/<name>-XXXXXX` under the package; the caller removes it. */
export function temporaryFolder(name: string): string {
  mkdirSync(join(packageRoot, ".tmp"), { recursive: true });
  return mkdtempSync(join(packageRoot, ".tmp", `${name}-`));
}

/** Writes `<dir>/prisma.config.ts` for the schema folder and the migrations folder given; returns its path. */
export function writePrismaConfig(dir: string, migrations: string): string {
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "prisma.config.ts");
  writeFileSync(
    config,
    [
      'import { defineConfig } from "prisma/config";',
      "export default defineConfig({",
      `  schema: ${JSON.stringify(join(packageRoot, "prisma", "schema"))},`,
      `  migrations: { path: ${JSON.stringify(migrations)} },`,
      "  datasource: { url: process.env.DATABASE_URL_OWNER },",
      "});",
      "",
    ].join("\n"),
  );
  return config;
}

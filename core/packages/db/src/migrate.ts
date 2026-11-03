// The migration runner: Prisma's own `migrate deploy`, run as the owner in a child process, since
// Prisma 7 has no programmatic migrate API and a second implementation of its bookkeeping would drift
// from `migrate dev` and `migrate status`. The api host calls runMigrations() before it listens
// (docs/architecture.md §3); `pnpm db:migrate` is the same call from the command line.
import { join } from "node:path";
import { databaseUrl } from "./env.ts";
import { packageRoot } from "./paths.ts";
import { prisma } from "./prisma-cli.ts";

export type RunMigrationsOptions = {
  /** The owner's connection string; the default is DATABASE_URL_OWNER. */
  readonly url?: string;
  /** Another prisma.config.ts, for a tool or a test that keeps its migrations elsewhere. */
  readonly config?: string;
};

/**
 * Applies the pending migrations as the owner and returns their names in the order applied, an empty
 * list when there was nothing to apply. Throws when a migration fails or the CLI refuses (a failed
 * migration recorded earlier, no reachable database), with the CLI's output in the message.
 */
export async function runMigrations(options: RunMigrationsOptions = {}): Promise<string[]> {
  const url = options.url ?? databaseUrl("owner");
  const config = options.config ?? join(packageRoot, "prisma.config.ts");
  const run = await prisma(["migrate", "deploy", "--config", config], { url, stdio: "pipe" });
  if (run.code !== 0) {
    throw new Error(
      `prisma migrate deploy exited ${run.code ?? "by signal"}:\n${run.stdout}${run.stderr}`.trimEnd(),
    );
  }
  return [...run.stdout.matchAll(/^Applying migration `([^`]+)`/gm)].map((match) => match[1] ?? "");
}

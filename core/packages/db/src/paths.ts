// Where this package lives, found by walking up so the same code runs from src/ and from dist/, and
// .env.local at the repository root, written by `pnpm env:create` (deploy/README.md), loaded without
// overriding what the environment already carries, so the GitLab job and a deployment pass theirs.
// Nothing of the platform is imported here: the commands that run before anything is built
// (schema-lint, migrations-check, generate) depend on this file alone.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function findUp(from: string, marker: string): string {
  let dir = from;
  while (!existsSync(join(dir, marker))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${marker} not found above ${from}`);
    dir = parent;
  }
  return dir;
}

/** core/packages/db, the folder with prisma.config.ts. */
export const packageRoot = findUp(import.meta.dirname, "prisma.config.ts");
/** The repository root, the folder with pnpm-workspace.yaml and .env.local. */
export const repositoryRoot = findUp(packageRoot, "pnpm-workspace.yaml");

let loaded = false;

/** Loads .env.local once, when it exists; a variable already set in the environment wins. */
export function loadEnvLocal(): void {
  if (loaded) return;
  loaded = true;
  const file = join(repositoryRoot, ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

// .env.local, written by `pnpm env:create` at the repository root, loaded before the first import of
// @whytide/platform, whose APP_ENV has no default. A variable the environment already carries wins, so
// a deployment, which has no .env.local, passes its own. Nothing of the platform is imported here.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Loads the .env.local of the repository above `from`, when there is one. */
export function loadEnvLocal(from: string = import.meta.dirname): void {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const file = join(dir, ".env.local");
      if (existsSync(file)) process.loadEnvFile(file);
      return;
    }
    if (dirname(dir) === dir) return;
  }
}

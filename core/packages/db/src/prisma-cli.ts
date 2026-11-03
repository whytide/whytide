// The Prisma CLI of this package, run in a child process: the one way every command here calls it,
// since Prisma 7 has no programmatic migrate API. The CLI phones checkpoint.prisma.io for update
// notices and usage data unless CHECKPOINT_DISABLE is set: it is, so the api starting up, a test or
// `pnpm db:generate` makes no network call beyond the database.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { packageRoot } from "./paths.ts";

export type PrismaRun = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type PrismaOptions = {
  /** The owner's connection string, set as DATABASE_URL_OWNER for the CLI; none for `generate`. */
  readonly url?: string;
  /** Output captured (`pipe`), or the terminal's for the interactive commands (`inherit`). */
  readonly stdio: "pipe" | "inherit";
};

export function prisma(args: readonly string[], options: PrismaOptions): Promise<PrismaRun> {
  const cli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  const env: NodeJS.ProcessEnv = { ...process.env, CHECKPOINT_DISABLE: "1" };
  if (options.url) env.DATABASE_URL_OWNER = options.url;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: packageRoot,
      env,
      stdio: options.stdio === "pipe" ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

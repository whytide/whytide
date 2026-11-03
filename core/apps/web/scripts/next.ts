// `node scripts/next.ts <dev|build|start|typegen>` (README "Run"): Next.js with the worktree's
// environment, .env.local loaded when there is one; NEXT_PUBLIC_API_URL from webConfig, else the api
// at API_PORT; telemetry and the SWC wasm download off, so nothing leaves the laptop but `next dev`'s
// one version check; `dev` and `start` on WEB_PORT at 127.0.0.1.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/** The variables every next command runs with. */
export function nextEnv(env: Env, apiUrl: string | undefined): Env {
  const api = apiUrl ?? (env.API_PORT ? `http://127.0.0.1:${env.API_PORT}` : undefined);
  if (!api) throw new Error("web: set NEXT_PUBLIC_API_URL or API_PORT (deploy/.env.example)");
  return {
    ...env,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_DISABLE_SWC_WASM: "1",
    NEXT_PUBLIC_API_URL: api,
  };
}

if (import.meta.main) {
  const envFile = join(import.meta.dirname, "..", "..", "..", "..", ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { webConfig } = await import("../config.ts");
  const [command = "dev", ...rest] = process.argv.slice(2);
  const port = webConfig.WEB_PORT === undefined ? [] : ["--port", String(webConfig.WEB_PORT)];
  const listen =
    command === "dev" || command === "start" ? [...port, "--hostname", "127.0.0.1"] : [];
  const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [next, command, ...listen, ...rest], {
    stdio: "inherit",
    env: nextEnv(process.env, webConfig.NEXT_PUBLIC_API_URL) as NodeJS.ProcessEnv,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

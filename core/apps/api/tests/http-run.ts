// `pnpm http:run <file>` (README "The .http file"): every request of a .http file, in order, against
// the worktree's api, one line each with its status and the request line as written, never a value
// of the environment. The variables are the `dev` environment of api-calls/http-client.env.json, then
// the git-ignored http-client.private.env.json over it, then what .env.local sets: `baseUrl` from
// API_PORT, `appOrigin` from APP_PUBLIC_ORIGIN, the origin the api takes a cookie-carrying change
// from, and `workerHealthUrl`, the worker's health server, from WORKER_HEALTH_PORT. It reaches
// 127.0.0.1 only, so that the session cookie never leaves the laptop. Exit code 1 when an answer is
// 400 or above.
//   node dist/tests/http-run.js <file>
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppError, isAppError } from "@whytide/platform";
import { z } from "zod";
import { openapiErrors } from "../openapi/errors.ts";
import { EXPECTED_URL, parseHttpFile, requestHost, substitute } from "../openapi/http-file.ts";

/** core/apps/api and the repository, from dist/tests/ where this runs. */
export const apiDir = resolve(import.meta.dirname, "..", "..");
export const repoDir = resolve(apiDir, "..", "..", "..");
export const envFile = join(repoDir, "api-calls", "http-client.env.json");
export const privateEnvFile = join(repoDir, "api-calls", "http-client.private.env.json");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const environments = z.record(z.string(), z.record(z.string(), z.string()));

export type HttpResult = {
  readonly title: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
};

/** The environment's variables: the committed file's, the private file's, then the overrides set. */
export function loadVariables(options: {
  readonly envFile: string;
  readonly privateFile: string;
  readonly environment: string;
  readonly overrides?: Readonly<Record<string, string | undefined>>;
}): Record<string, string> {
  const read = (file: string) =>
    existsSync(file) ? environments.parse(JSON.parse(readFileSync(file, "utf8"))) : {};
  const { environment, overrides = {} } = options;
  const set = Object.entries(overrides).filter((entry): entry is [string, string] => !!entry[1]);
  return {
    ...read(options.envFile)[environment],
    ...read(options.privateFile)[environment],
    ...Object.fromEntries(set),
  };
}

/** A base URL on the loopback, or http_target_refused. */
export function loopbackUrl(baseUrl: string | undefined): URL {
  const url = URL.parse(baseUrl ?? "");
  if (!url || !/^https?:$/.test(url.protocol) || !LOOPBACK.has(url.hostname)) {
    throw new AppError(openapiErrors.http_target_refused, { details: { expected: "127.0.0.1" } });
  }
  return url;
}

export async function runHttpFile(
  file: string,
  variables: Readonly<Record<string, string>>,
): Promise<HttpResult[]> {
  const results: HttpResult[] = [];
  for (const request of parseHttpFile(readFileSync(file, "utf8"), file)) {
    const host = requestHost(request.url);
    const url = new URL(substitute(request.url, variables));
    if (host === undefined || url.origin !== loopbackUrl(variables[host]).origin) {
      const details = { file, line: request.line, expected: EXPECTED_URL };
      throw new AppError(openapiErrors.http_file_invalid, { details });
    }
    const res = await fetch(url, {
      method: request.method,
      headers: request.headers.map(([name, value]) => [name, substitute(value, variables)]),
      ...(request.body === undefined ? {} : { body: substitute(request.body, variables) }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await res.arrayBuffer();
    const { title, method } = request;
    results.push({ title, method, url: request.url, status: res.status });
  }
  return results;
}

if (import.meta.main) {
  const [file] = process.argv.slice(2);
  if (!file) throw new Error("usage: pnpm http:run <file>");
  const { API_PORT: port, APP_PUBLIC_ORIGIN: origin, WORKER_HEALTH_PORT: worker } = process.env;
  const variables = loadVariables({
    envFile,
    privateFile: privateEnvFile,
    environment: "dev",
    overrides: {
      baseUrl: port ? `http://127.0.0.1:${port}` : undefined,
      appOrigin: origin ? new URL(origin).origin : undefined,
      workerHealthUrl: worker ? `http://127.0.0.1:${worker}` : undefined,
    },
  });
  try {
    const results = await runHttpFile(
      resolve(process.env.INIT_CWD ?? process.cwd(), file),
      variables,
    );
    for (const { status, method, url } of results)
      process.stdout.write(`${status} ${method} ${url}\n`);
    process.exitCode = results.every(({ status }) => status < 400) ? 0 : 1;
  } catch (error) {
    if (!isAppError(error)) throw error;
    process.stdout.write(`http:run: ${error.code} ${JSON.stringify(error.details ?? {})}\n`);
    process.exitCode = 1;
  }
}

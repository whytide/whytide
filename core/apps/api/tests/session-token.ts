// `pnpm session:token <email>` (README "The .http file"): a session of the user, opened through the
// authentication port's fake on the worktree's api, by its sign-in route (POST
// /api/auth/fake/sign-in, under APP_ENV=test, for an email the configured hooks allow), and its cookie
// written as `dev.sessionCookie` into api-calls/http-client.private.env.json, which git ignores, with
// mode 600. It never prints the cookie.
//   node dist/tests/session-token.js <email>
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { AppError, isAppError } from "@whytide/platform";
import { authSessionCookie } from "@whytide/providers";
import { openapiErrors } from "../openapi/errors.ts";
import { loopbackUrl, privateEnvFile } from "./http-run.ts";

/** The fake's test sign-in route (core/packages/providers/auth/fake). */
const SIGN_IN_PATH = "/api/auth/fake/sign-in";

export async function sessionToken(options: {
  readonly baseUrl: string;
  readonly email: string;
  readonly file: string;
  readonly environment?: string;
}): Promise<void> {
  const url = new URL(SIGN_IN_PATH, loopbackUrl(options.baseUrl));
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: options.email }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  const cookie = res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .find((pair) => pair.startsWith(`${authSessionCookie.name}=`));
  if (res.status !== 204 || cookie === undefined) {
    const code = /"code":"([a-z0-9_]+)"/.exec(text)?.[1];
    throw new AppError(openapiErrors.session_token_refused, {
      details: { status: res.status, code },
    });
  }
  const environment = options.environment ?? "dev";
  const exists = existsSync(options.file);
  if (exists) chmodSync(options.file, 0o600); // before the cookie is in it
  const current = exists
    ? (JSON.parse(readFileSync(options.file, "utf8")) as Record<string, Record<string, string>>)
    : {};
  const next = { ...current, [environment]: { ...current[environment], sessionCookie: cookie } };
  writeFileSync(options.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

if (import.meta.main) {
  const [email] = process.argv.slice(2);
  if (!email) throw new Error("usage: pnpm session:token <email>");
  const baseUrl = `http://127.0.0.1:${process.env.API_PORT ?? 3001}`;
  try {
    await sessionToken({ baseUrl, email, file: privateEnvFile });
    say("session:token: dev.sessionCookie written to api-calls/http-client.private.env.json");
  } catch (error) {
    if (!isAppError(error)) throw error;
    say(`session:token: ${error.code} ${JSON.stringify(error.details ?? {})}`);
    process.exitCode = 1;
  }
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

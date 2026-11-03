// The test sign-in helper (README.md "Signing in from tests"): signInAs(userId) opens a session of
// the user on the fake of this process, asking no hook, and returns its cookie in the shape that
// Playwright's context.addCookies takes, as plain fields with no Playwright import; an API test
// sends each `name=value` in its Cookie header. An app running in another process does not see
// that session: a test signs in there through the fake's POST /api/auth/fake/sign-in, under
// APP_ENV=test.
import { authFake } from "../fake/index.ts";
import { authSessionCookie } from "../port.ts";

/** A cookie as Playwright's context.addCookies takes it: host-only on `domain`. */
export type TestCookie = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: "Lax";
};

/** A new session of the user on the fake: its cookie for the app's host, `localhost` by default. */
export function signInAs(userId: string, { domain = "localhost" } = {}): TestCookie[] {
  const { name, path, httpOnly, secure, sameSite } = authSessionCookie;
  return [
    { name, value: authFake.createSession(userId), domain, path, httpOnly, secure, sameSite },
  ];
}

/** The Better Auth adapter's tests start it on their schema's client (better-auth/README.md). */
export { useAuthDatabase } from "../better-auth/database.ts";

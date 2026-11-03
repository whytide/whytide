// The fake's contract suite (README.md "The contract suite"). Its follow() is fetch, which
// no-raw-fetch allows in an adapter's folder, and checks on the way that links() kept every link
// the cases open, so that a test may read one there instead of the mail. Then two things of the
// fake's own: it keeps no request of resolvePrincipal, and it refuses to start in production, the
// child process that shows it also pinning the cookie no case sees there: `__Host-` and Secure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { contractSuite } from "../../../testing/index.ts";
import { authCases } from "../../contract.ts";
import { authPort, authSessionCookie } from "../../port.ts";
import { authFake, authFakeAdapter } from "../index.ts";

contractSuite(
  authPort,
  authFakeAdapter,
  authCases(async (url, init) => {
    const path = url.pathname + url.search;
    assert.ok(
      authFake.links().some((link) => path.startsWith(link.url)),
      "links() kept the link",
    );
    return fetch(url, { ...init, redirect: "manual" });
  }),
);

test("recordedCalls keeps no call of resolvePrincipal: no request, no cookie", async () => {
  authFake.reset();
  await authFake.resolvePrincipal({ headers: { cookie: `${authSessionCookie.name}=token` } });
  assert.deepEqual(authFake.recordedCalls, []);
});

test("under APP_ENV=production the cookie is __Host- and Secure, and create() refuses", () => {
  const [port, fake] = ["../../port.ts", "../index.ts"].map((path) => import.meta.resolve(path));
  const script = [
    `const { authSessionCookie: cookie } = await import(${JSON.stringify(port)});`,
    "console.log(cookie.name, cookie.secure);",
    `const { authFakeAdapter } = await import(${JSON.stringify(fake)});`,
    "try { authFakeAdapter.create(); } catch (error) { console.log(error.code); }",
  ].join("\n");
  const env = { ...process.env, APP_ENV: "production" };
  const argv = ["--input-type=module", "-e", script];
  const child = spawnSync(process.execPath, argv, { env, encoding: "utf8" });
  const expected = "__Host-whytide_session true\nauth_fake_in_production\n";
  assert.equal(child.stdout, expected, child.stderr);
});

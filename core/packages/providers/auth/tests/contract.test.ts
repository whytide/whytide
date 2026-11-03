// The fake's test sign-in (README.md "Signing in from tests"), end to end: its handler mounted on a
// node:http server of the test's own, real HTTP requests to 127.0.0.1, and GET /me on that server
// resolving the principal as the api will. The route is there under APP_ENV=test only, which the
// platform reads once, at import: this file sets it before importing anything that reads it, and
// the first test boots the handler in child processes under test, development, an unset APP_ENV
// and production. The task names this file tests/test-sign-in.test.ts; it is the port's
// tests/contract.test.ts because `pnpm -F providers test:contract` runs that name and no other.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { AuthHandler, AuthHooks } from "../port.ts";

process.env.APP_ENV = "test";
const { isAppError } = await import("@whytide/platform");
const { bindPort } = await import("../../_pattern/index.ts");
const { AUTH_SESSION_TTL_MS, authPort } = await import("../port.ts");
const { SIGN_IN_PATH, authFake, authFakeAdapter } = await import("../fake/index.ts");
const { signInAs } = await import("../testing/index.ts");

const ADA = "ada@example.com";
const BAO = "bao@example.com";
const EVE = "eve@example.com";
/** ADA's sign-in body, padded with JSON whitespace to `size` bytes. */
const padded = (size: number) => JSON.stringify({ email: ADA }).padEnd(size, " ");
const chunked = "Transfer-Encoding: chunked\r\n";
/** One chunk of a chunked body. */
const chunk = (data: string) => `${data.length.toString(16)}\r\n${data}\r\n`;

/**
 * The fake configured with an allow-list of ADA and BAO and a users store whose ids are
 * `usr_<local part>`, its handler on a server of the test's own, whose next() answers a port code
 * with its status, GET /me with the user id of the request's principal, and anything else 404. The
 * host answers a request with `x-host: answers` as soon as the handler has it, on a timeout say,
 * and reads the body of one with `x-host: reads` before the handler sees it.
 */
async function desk(t: TestContext) {
  const auth = bindPort(authPort, authFakeAdapter.create(), { adapter: "fake" });
  authFake.reset();
  const allowed = new Set([ADA, BAO]);
  const asked: string[] = [];
  const errors: unknown[] = [];
  const hooks: AuthHooks = {
    allowSignIn: async (email) => {
      asked.push(email);
      return allowed.has(email);
    },
    mail: { send: async () => undefined },
    users: { findOrCreateByEmail: async (email) => ({ id: `usr_${email.split("@")[0]}` }) },
  };
  await auth.configure(hooks);
  const mounted: AuthHandler[] = [];
  await auth.mountHandler({ use: (handler) => mounted.push(handler) });
  const [handler] = mounted;
  assert.ok(handler && mounted.length === 1, "mountHandler mounts one handler");
  const server = createServer((req, res) => {
    const run = () =>
      handler(req, res, (error) => {
        if (error !== undefined) {
          errors.push(error);
          const code = isAppError(error) ? error.code : "";
          return void res.writeHead(isAppError(error) ? error.status : 500).end(code);
        }
        if (req.url !== "/me") return void res.writeHead(404).end();
        void auth.resolvePrincipal(req).then((principal) => res.end(principal?.userId ?? "nobody"));
      });
    if (req.headers["x-host"] === "reads") return void req.resume().on("end", run);
    run();
    if (req.headers["x-host"] === "answers") res.writeHead(503).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  /** POSTs the body, JSON unless a string, to the sign-in route as `type`; 5 s at most. */
  const post = (body: unknown, type = "application/json", headers: Record<string, string> = {}) =>
    fetch(origin + SIGN_IN_PATH, {
      method: "POST",
      headers: { "content-type": type, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  /** The user id that a request carrying this Cookie header resolves to. */
  const whoami = async (cookie: string) =>
    (await fetch(`${origin}/me`, { headers: { cookie } })).text();
  /**
   * A JSON POST to the sign-in route written over a node:net socket as it is, which fetch would not
   * send: the head with `lines`, then `body`, at once or, with `afterAnswer`, once the server has
   * answered. What came back once the connection closed, or once the client gave up after `ms` idle.
   */
  const raw = (lines: string, body: string, { afterAnswer = false, ms = 2000 } = {}) =>
    new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1").setTimeout(ms, () => socket.destroy());
      const head = `POST ${SIGN_IN_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n${lines}\r\n`;
      let got = "";
      socket.on("data", (data: Buffer) => {
        if (afterAnswer && got === "") socket.write(body);
        got += data.toString();
      });
      socket.on("error", () => socket.destroy()).on("close", () => resolve(got));
      socket.write(afterAnswer ? head : head + body);
    });
  return { auth, hooks, asked, errors, origin, post, raw, whoami };
}

test("POST /api/auth/fake/sign-in is there under APP_ENV=test only; production never starts the fake nor opens a session", async () => {
  const fake = JSON.stringify(import.meta.resolve("../fake/index.ts"));
  // Mounted by hand, around create()'s refusal: under production too, the route is absent.
  const script = [
    `const { SIGN_IN_PATH, authFake, authFakeAdapter } = await import(${fake});`,
    'const { createServer } = await import("node:http");',
    'let refused = "-";',
    "try { authFakeAdapter.create(); } catch (error) { refused = error.code; }",
    'let session = "opened";',
    'try { authFake.createSession("usr_ada"); } catch (error) { session = error.code; }',
    "const users = { findOrCreateByEmail: async () => ({ id: 'usr_ada' }) };",
    "const mail = { send: async () => undefined };",
    "await authFake.configure({ allowSignIn: async () => true, mail, users });",
    "const mounted = [];",
    "await authFake.mountHandler({ use: (handler) => mounted.push(handler) });",
    "const next = (res) => (error) => res.writeHead(error ? 500 : 404).end();",
    "const server = createServer((req, res) => mounted[0](req, res, next(res)));",
    'await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
    'const url = "http://127.0.0.1:" + server.address().port + SIGN_IN_PATH;',
    'const headers = { "content-type": "application/json" };',
    `const body = ${JSON.stringify(JSON.stringify({ email: ADA }))};`,
    'const response = await fetch(url, { method: "POST", headers, body });',
    "console.log(refused, session, response.status, response.headers.getSetCookie().length);",
    "server.closeAllConnections();",
    "server.close();",
  ].join("\n");
  const boot = async (APP_ENV: string | undefined) => {
    const env = { ...process.env, APP_ENV };
    const argv = ["--input-type=module", "-e", script];
    return promisify(execFile)(process.execPath, argv, { env }).then(
      ({ stdout }) => stdout,
      // The import fails: the code and the variable of the error Node prints, or all it printed.
      ({ stderr }: { stderr: string }) =>
        /code: '(\w+)'.*'(APP_ENV):/s.exec(stderr)?.slice(1).join(" ") ?? stderr,
    );
  };
  const modes = ["test", "development", undefined, "production"];
  assert.deepEqual(await Promise.all(modes.map(boot)), [
    "- opened 204 1\n",
    "- opened 404 0\n",
    "config_invalid APP_ENV", // an unset APP_ENV stops the platform's import: nothing is mounted
    "auth_fake_in_production auth_fake_in_production 404 0\n",
  ]);
});

test("a request carrying the cookie of signInAs(userId) resolves to that user; the jar is Playwright's shape", async (t) => {
  const { auth, whoami } = await desk(t);
  const jar = signInAs("usr_ada");
  const value = jar[0]?.value ?? "";
  assert.match(value, /^[\w-]{43}$/, "a token of 32 random bytes");
  assert.deepEqual(jar, [
    {
      name: "whytide_session",
      value,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const header = jar.map(({ name, value }) => `${name}=${value}`).join("; ");
  assert.equal(await whoami(`theme=dark; ${header}`), "usr_ada");
  assert.equal(signInAs("usr_ada", { domain: "127.0.0.1" })[0]?.domain, "127.0.0.1");
  assert.throws(() => signInAs(""), { code: "auth_input_invalid" });
  await auth.revokeUser("usr_bao");
  assert.throws(() => signInAs("usr_bao"), { code: "auth_invite_required" });
});

test("the route signs an allowed email in, as following a link does: the cookie, no-store, no-referrer", async (t) => {
  const { asked, origin, post, whoami } = await desk(t);
  const response = await post({ email: " Ada@Example.COM " }, "application/json; charset=utf-8");
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const [pair = "", ...flags] = response.headers.getSetCookie()[0]?.split("; ") ?? [];
  const maxAge = `Max-Age=${AUTH_SESSION_TTL_MS / 1000}`;
  assert.deepEqual(flags, ["Path=/", maxAge, "HttpOnly", "SameSite=Lax"], "no Domain, no Secure");
  assert.deepEqual(asked, [ADA], "the hooks see the email trimmed and lowercased");
  assert.equal(await whoami(pair), "usr_ada");
  assert.equal((await fetch(origin + SIGN_IN_PATH)).status, 404, "a GET goes on to the host");
  assert.equal((await post(padded(4096))).status, 204, "a body of 4,096 bytes, the limit");
});

test("no session for a refused or revoked email, or a body other than { email } as JSON", async (t) => {
  const { auth, asked, errors, post } = await desk(t);
  await auth.revokeUser("usr_bao");
  const refused = "403 auth_invite_required";
  const invalid = "400 auth_input_invalid";
  const json = "application/json";
  const cases: [unknown, string, string][] = [
    [{ email: EVE }, json, refused],
    [{ email: BAO }, json, refused],
    [{ email: ADA }, "text/plain", invalid],
    ['{"email":', json, invalid],
    [null, json, invalid],
    [{ email: "ada" }, json, invalid],
    [{ email: ADA, userId: "usr_eve" }, json, invalid],
    [{ email: `${"a".repeat(250)}@example.com` }, json, invalid],
  ];
  for (const [body, type, expected] of cases) {
    const response = await post(body, type);
    const label = `${type} ${JSON.stringify(body).slice(0, 40)}`;
    assert.equal(`${response.status} ${await response.text()}`, expected, label);
    assert.deepEqual(response.headers.getSetCookie(), [], label);
  }
  assert.deepEqual(asked, [EVE, BAO], "a refused body asks no hook");
  for (const error of errors) {
    assert.ok(isAppError(error), "next gets a port code");
    assert.doesNotMatch(JSON.stringify([error.message, error.details]), /@|aaaa|usr_/);
  }
});

test("a users hook failing or returning no id: next gets a port code, no session", async (t) => {
  const { auth, hooks, post } = await desk(t);
  const broken: [AuthHooks["users"]["findOrCreateByEmail"], string][] = [
    [async () => ({ id: "" }), "500 auth_hook_invalid"],
    [async () => Promise.reject(new Error("the users store is down")), "500 auth_error_unmapped"],
  ];
  for (const [findOrCreateByEmail, expected] of broken) {
    await auth.configure({ ...hooks, users: { findOrCreateByEmail } });
    const response = await post({ email: ADA });
    assert.equal(`${response.status} ${await response.text()}`, expected);
    assert.deepEqual(response.headers.getSetCookie(), []);
  }
});

test("a body over 4,096 bytes, declared or sent in chunks, is refused at once and its connection closed", async (t) => {
  const { post, raw } = await desk(t);
  const over = await post(padded(4097));
  assert.equal(`${over.status} ${over.headers.get("connection")}`, "400 close", "4,097 bytes");
  assert.deepEqual(over.headers.getSetCookie(), []);
  const closed = /^HTTP\/1\.1 400 [^]*\r\nconnection: close\r\n/i;
  // Ten gigabytes declared and a hundred bytes sent: refused without waiting for the rest.
  assert.match(await raw("Content-Length: 10000000000\r\n", padded(100)), closed, "declared");
  assert.match(await raw(chunked, chunk("x".repeat(5000))), closed, "5,000 bytes in a chunk");
});

test("a host that answered or read the body first, or a client gone mid-body: the process lives, next gets a port code", async (t) => {
  const { errors, post, raw } = await desk(t);
  // The host answers first, then the body goes over 4 KiB: the request ends there, nothing throws.
  const answers = `x-host: answers\r\n${chunked}`;
  const answered = await raw(answers, chunk("x".repeat(5000)), { afterAnswer: true });
  assert.match(answered, /^HTTP\/1\.1 503 /);
  assert.equal((await post({ email: ADA })).status, 204, "the server answers the next request");
  // The host read the body before the handler: refused at once, not awaited.
  const read = await post({ email: ADA }, "application/json", { "x-host": "reads" });
  assert.equal(`${read.status} ${await read.text()}`, "400 auth_input_invalid");
  // The client goes mid-body: next gets auth_input_invalid, not the socket's ECONNRESET.
  errors.length = 0;
  await raw(chunked, '1e\r\n{"email":', { ms: 100 });
  for (let tries = 0; errors.length === 0 && tries < 100; tries++) await delay(10);
  assert.deepEqual(
    errors.map((error) => isAppError(error) && error.code),
    ["auth_input_invalid"],
  );
});

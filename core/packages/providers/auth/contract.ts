// The authentication port's contract (README.md "The contract suite"): what every adapter does,
// the fake now and Better Auth from alpha-p3-020, through its handler mounted on a node:http server
// of the test's own and real HTTP requests. Each case configures the port with test hooks: an
// allow-list of ADA and BAO, a mail recorder (the fake mail adapter) and an in-memory users store
// whose ids are `usr_<local part>`. A link is followed as a browser does, its GET then the confirm
// page's POST, through the `follow` the adapter's contract test passes in: fetch there, in the
// adapter's folder, where no-raw-fetch allows it. A request target fetch would not send goes over a
// node:net socket. Every request reaches 127.0.0.1 only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import type { TestContext } from "node:test";
import { isAppError } from "@whytide/platform";
import type { PortInstance } from "../_pattern/index.ts";
import type { ContractCases } from "../testing/index.ts";
import {
  AUTH_LINK_CONFIRM_PATH,
  AUTH_LINK_FAILED_PATH,
  AUTH_LINK_TTL_MS,
  AUTH_SESSION_TTL_MS,
  type AuthHandler,
  type AuthHooks,
  type AuthMail,
  type authPort,
  authSessionCookie,
} from "./port.ts";

type Auth = PortInstance<typeof authPort>;
/** A request of the URL, a GET unless `init` says otherwise, that does not follow redirects. */
export type Follow = (
  url: URL,
  init?: { readonly method: "POST"; readonly headers: Record<string, string> },
) => Promise<Response>;

const ADA = "ada@example.com";
const BAO = "bao@example.com";
const EVE = "eve@example.com";

/** The port configured with the test hooks, its handler on a node:http server of the test's own. */
async function desk(auth: Auth, t: TestContext, follow: Follow) {
  const allowed = new Set([ADA, BAO]);
  const mail: AuthMail[] = [];
  const users = new Map<string, string>();
  const hooks: AuthHooks = {
    allowSignIn: async (email) => allowed.has(email),
    mail: { send: async (message) => mail.push(message) },
    users: {
      findOrCreateByEmail: async (email) => {
        users.set(email, `usr_${email.split("@")[0]}`);
        return { id: users.get(email) ?? "" };
      },
    },
  };
  await auth.configure(hooks);
  const mounted: AuthHandler[] = [];
  await auth.mountHandler({ use: (handler) => mounted.push(handler) });
  const [handler] = mounted;
  assert.ok(handler && mounted.length === 1, "mountHandler mounts one handler");
  const server = createServer((req, res) =>
    handler(req, res, (error) => {
      res.writeHead(error ? 500 : 404).end(isAppError(error) ? error.code : undefined);
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  /** The status line answering a GET of the target sent as it is, which fetch would not send. */
  const statusOf = (target: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1").setTimeout(2000, () => socket.destroy());
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk)).on("error", () => socket.destroy());
      socket.on("close", () => resolve(Buffer.concat(chunks).toString().split("\r\n")[0] ?? ""));
      socket.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    });
  /** The link mailed last to the email, on this server: an absolute link keeps its path only. */
  const linkTo = (email: string) => {
    const text = mail.findLast((message) => message.to === email)?.text ?? "";
    const link = new URL(/(?:https?:\/\/[^\s/]+)?\/api\/auth\/\S+/.exec(text)?.[0] ?? "", origin);
    assert.match(link.pathname, /^\/api\/auth\//, "a sign-in link in the mail");
    return new URL(link.pathname + link.search, origin);
  };
  /**
   * Follows a link as a browser does: its GET lands on the confirm page and opens nothing (the
   * confirm step, README.md "The sign-in link"); the page's POST, from `origin`, answers.
   */
  const open = async (link: URL, origin = link.origin) => {
    const page = await follow(link);
    assertRedirect(page);
    const target = new URL(page.headers.get("location") ?? "", link);
    assert.equal(target.pathname, AUTH_LINK_CONFIRM_PATH);
    assert.equal(target.searchParams.get("link"), link.pathname + link.search);
    assert.deepEqual(page.headers.getSetCookie(), [], "a GET sets no cookie");
    return follow(link, { method: "POST", headers: { origin } });
  };
  /** Requests a link and follows it: the session cookie, `name=value`. */
  const signIn = async (email: string, redirectTo = "/w/acme") => {
    await auth.requestMagicLink({ email, redirectTo });
    return sessionCookieOf(await open(linkTo(email)));
  };
  const principalOf = (cookie: string) => auth.resolvePrincipal({ headers: { cookie } });
  return { allowed, hooks, mail, users, linkTo, open, signIn, principalOf, statusOf };
}

/** A 302 or 303 that no cache keeps and that sends no Referer on. */
function assertRedirect(response: Response) {
  assert.ok([302, 303].includes(response.status), `a redirect, not ${response.status}`);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
}

/** The session cookie a redirect sets, with the attributes of README.md "The session cookie". */
function sessionCookieOf(response: Response): string {
  assertRedirect(response);
  const set = response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${authSessionCookie.name}=`));
  assert.ok(set, "the session cookie is set");
  const [pair = "", ...rest] = set.split(";").map((part) => part.trim());
  const flags = rest.map((flag) => flag.toLowerCase());
  for (const flag of ["httponly", "samesite=lax", "path=/"]) assert.ok(flags.includes(flag), flag);
  assert.ok(flags.includes(`max-age=${authSessionCookie.maxAgeSeconds}`), "max-age");
  assert.equal(flags.includes("secure"), authSessionCookie.secure, "Secure in production only");
  assert.equal(pair.startsWith("__Host-"), authSessionCookie.secure, "__Host- exactly when Secure");
  assert.ok(!flags.some((flag) => flag.startsWith("domain=")), "host-only");
  return pair;
}

/** A failed link: a redirect to AUTH_LINK_FAILED_PATH with the code, and no cookie. */
function assertExpired(response: Response) {
  assertRedirect(response);
  const target = new URL(response.headers.get("location") ?? "", "http://app.invalid");
  assert.equal(target.pathname, AUTH_LINK_FAILED_PATH);
  assert.equal(target.searchParams.get("code"), "auth_link_expired");
  assert.deepEqual(response.headers.getSetCookie(), [], "no cookie");
}

/** The cases, given how the adapter's contract test follows a link. */
export const authCases = (follow: Follow): ContractCases<typeof authPort> => ({
  // First, while the suite's instance has no hooks yet, as on a host whose modules export none.
  "until configure runs, every email is refused with auth_invite_required": async (auth) => {
    await assert.rejects(auth.requestMagicLink({ email: ADA, redirectTo: "/" }), (error) => {
      assert.ok(isAppError(error) && error.code === "auth_invite_required");
      return true;
    });
  },
  "a link for an allowed email signs the user in; resolvePrincipal finds the user by the cookie":
    async (auth, t) => {
      const { mail, users, linkTo, open, principalOf } = await desk(auth, t, follow);
      // The port trims and lowercases the email: every hook sees ada@example.com.
      const redirectTo = "/w/acme/leads?tier=a";
      await auth.requestMagicLink({ email: " Ada@Example.COM ", redirectTo });
      assert.deepEqual(
        mail.map((message) => message.to),
        [ADA],
      );
      assert.equal(users.size, 0, "the user is created when the link is followed");
      const link = linkTo(ADA);
      // Parameters added to the link do not move the redirect off the page requested.
      for (const name of ["redirectTo", "callbackURL", "next"]) {
        link.searchParams.append(name, "//evil.example");
      }
      const response = await open(link);
      const cookie = sessionCookieOf(response);
      const target = new URL(response.headers.get("location") ?? "", link);
      assert.equal(target.origin + target.pathname + target.search, `${link.origin}${redirectTo}`);
      const principal = await principalOf(`theme=dark; ${cookie}`);
      assert.ok(principal);
      assert.equal(principal.userId, users.get(ADA));
      assert.ok(!cookie.endsWith(`=${principal.sessionId}`), "the session id is not the token");
      assert.equal(await auth.isSecondFactorEnrolled(principal.userId), false);
      assert.equal(await auth.resolvePrincipal({ headers: {} }), null);
      assert.equal(await principalOf(`${authSessionCookie.name}=forged`), null);
    },
  "a consumed link fails with auth_link_expired": async (auth, t) => {
    const { linkTo, open } = await desk(auth, t, follow);
    await auth.requestMagicLink({ email: ADA, redirectTo: "/" });
    const link = linkTo(ADA);
    sessionCookieOf(await open(link));
    assertExpired(await open(link));
  },
  "a link's GET opens no session and spends nothing; a POST from another site fails": async (
    auth,
    t,
  ) => {
    const { linkTo, open } = await desk(auth, t, follow);
    await auth.requestMagicLink({ email: ADA, redirectTo: "/" });
    const link = linkTo(ADA);
    assertExpired(await open(link, "https://evil.example"));
    sessionCookieOf(await open(link));
  },
  "an expired link fails with auth_link_expired; a session ends after its lifetime": async (
    auth,
    t,
  ) => {
    const { linkTo, open, signIn, principalOf } = await desk(auth, t, follow);
    const cookie = await signIn(ADA);
    await auth.requestMagicLink({ email: BAO, redirectTo: "/" });
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + AUTH_LINK_TTL_MS + 1000 });
    assertExpired(await open(linkTo(BAO)));
    assert.ok(await principalOf(cookie));
    t.mock.timers.tick(AUTH_SESSION_TTL_MS);
    assert.equal(await principalOf(cookie), null);
  },
  "signOutEverywhere and revokeUser end every session of the user, and no one else's": async (
    auth,
    t,
  ) => {
    const { users, signIn, principalOf } = await desk(auth, t, follow);
    const sessions = [await signIn(ADA), await signIn(ADA)];
    const other = await signIn(BAO);
    const ada = users.get(ADA) ?? "";
    await auth.signOutEverywhere(ada);
    for (const cookie of sessions) assert.equal(await principalOf(cookie), null);
    assert.equal((await principalOf(other))?.userId, users.get(BAO));
    const again = await signIn(ADA);
    await auth.revokeUser(ada);
    assert.equal(await principalOf(again), null);
    assert.equal((await principalOf(other))?.userId, users.get(BAO));
  },
  "a link requested before revokeUser signs no one in": async (auth, t) => {
    const { linkTo, open, signIn } = await desk(auth, t, follow);
    await signIn(ADA);
    await auth.requestMagicLink({ email: ADA, redirectTo: "/" });
    await auth.revokeUser("usr_ada");
    assertExpired(await open(linkTo(ADA)));
  },
  "a link whose email is refused by the time it is followed opens no session": async (auth, t) => {
    const { allowed, linkTo, open } = await desk(auth, t, follow);
    await auth.requestMagicLink({ email: ADA, redirectTo: "/" });
    allowed.delete(ADA);
    assertExpired(await open(linkTo(ADA)));
  },
  "a users hook failing or returning no id: next gets a port code, no session": async (auth, t) => {
    const { hooks, linkTo, open } = await desk(auth, t, follow);
    const broken: [AuthHooks["users"]["findOrCreateByEmail"], string][] = [
      [async () => ({ id: "" }), "auth_hook_invalid"],
      [async (email) => Promise.reject(new Error(`no user ${email}`)), "auth_error_unmapped"],
    ];
    for (const [findOrCreateByEmail, code] of broken) {
      await auth.configure({ ...hooks, users: { findOrCreateByEmail } });
      await auth.requestMagicLink({ email: ADA, redirectTo: "/" });
      const response = await open(linkTo(ADA));
      assert.equal(`${response.status} ${await response.text()}`, `500 ${code}`);
      assert.deepEqual(response.headers.getSetCookie(), []);
    }
  },
  "a request whose URL does not parse goes on to the host": async (auth, t) => {
    const { statusOf } = await desk(auth, t, follow);
    assert.match(await statusOf("//["), /^HTTP\/1\.1 404 /);
  },
  "a refused email fails with auth_invite_required: no mail, no user": async (auth, t) => {
    const { mail, users } = await desk(auth, t, follow);
    await assert.rejects(auth.requestMagicLink({ email: EVE, redirectTo: "/" }), (error) => {
      assert.ok(isAppError(error) && error.code === "auth_invite_required");
      assert.equal(error.status, 403);
      assert.doesNotMatch(JSON.stringify([error.message, error.details]), /eve/);
      return true;
    });
    assert.deepEqual(mail, []);
    assert.equal(users.size, 0);
  },
  "a redirectTo outside the app or under /api/, or a long email, fails with auth_input_invalid":
    async (auth, t) => {
      const { mail } = await desk(auth, t, follow);
      const outside = ["https://evil.example/", "//evil.example", "/\\evil.example"];
      outside.push("/\t/evil.example", "/.//evil.example", "javascript:alert(1)", "w/acme");
      outside.push("/api/auth/verify?token=x", "/API/x", "/%61pi/x", "/./api/x");
      outside.push("/w%2F/evil.example", "/w%5c/evil.example", "/%09/evil.example", "/%7F");
      const inputs = outside.map((redirectTo) => ({ email: ADA, redirectTo }));
      inputs.push({ email: `${"a".repeat(250)}@example.com`, redirectTo: "/" }); // over 254
      for (const input of inputs) {
        await assert.rejects(auth.requestMagicLink(input), (error) => {
          assert.ok(isAppError(error) && error.code === "auth_input_invalid", input.redirectTo);
          assert.doesNotMatch(JSON.stringify([error.message, error.details]), /evil|ada@|aaaa/);
          return true;
        });
      }
      assert.deepEqual(mail, []);
    },
});

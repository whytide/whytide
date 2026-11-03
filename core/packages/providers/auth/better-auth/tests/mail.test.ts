// The Better Auth adapter end to end (README.md "Tests"), on a schema of the worktree's database: the
// link goes out through the smtp adapter and is read back from Mailpit, shared by every worktree, so
// each test mails an address of its own; the users hook keeps tenancy's users table, as identity's
// does. The handler runs on a node:http server of the test's own; fetch is allowed in this folder.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { after, before, test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { defaultLocale, defineIds, isAppError, newId, renderMail } from "@whytide/platform";
import { bindPort, type PortInstance } from "../../../_pattern/index.ts";
import { appMailPort } from "../../../app-mail/port.ts";
import { smtpAdapter } from "../../../app-mail/smtp/index.ts";
import { loadEnvLocal, readMailpit } from "../../../app-mail/testing/index.ts";
import {
  AUTH_LINK_FAILED_PATH,
  AUTH_LINK_TTL_MS,
  type AuthHandler,
  type AuthHooks,
  type AuthMail,
  authPort,
} from "../../port.ts";
import { useAuthDatabase } from "../../testing/index.ts";
import { betterAuthAdapter } from "../index.ts";
import { digest } from "../store.ts";

loadEnvLocal();
withTestDb();
const ids = defineIds({ usr: "user" }); // tenancy's prefix: no module is loaded here
const db = () => asRole("app");
const sent: AuthMail[] = [];
let auth: PortInstance<typeof authPort>;
let hooks: AuthHooks;
let origin = "";
let server: Server | undefined;
after(() => server?.close());

before(async () => {
  useAuthDatabase(db());
  auth = bindPort(authPort, betterAuthAdapter.create(), { adapter: "better-auth" });
  const smtp = bindPort(appMailPort, smtpAdapter.create(), { adapter: "smtp" });
  hooks = {
    allowSignIn: async (email) => !email.startsWith("eve-"),
    mail: { send: async (message) => sent.push(message) && smtp.send(message) },
    users: {
      findOrCreateByEmail: (email) =>
        db().user.upsert({ where: { email }, create: { id: newId(ids.user), email }, update: {} }),
      findByEmail: (email) => db().user.findUnique({ where: { email } }),
      disable: (id) => db().user.update({ where: { id }, data: { disabledAt: new Date() } }),
    },
  };
  await auth.configure(hooks);
  const mounted: AuthHandler[] = [];
  await auth.mountHandler({ use: (handler) => mounted.push(handler) });
  const listening = createServer((req, res) =>
    mounted[0]?.(req, res, () => res.writeHead(404).end()),
  );
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
});

const address = (name: string) => `${name}-${randomUUID()}@example.com`;
/** A link followed as a browser does: its GET lands on the confirm page, whose POST answers. */
const open = async (url: URL) => {
  await fetch(url, { redirect: "manual" });
  return fetch(url, { method: "POST", redirect: "manual", headers: { origin: url.origin } });
};
const expired = `${AUTH_LINK_FAILED_PATH}?code=auth_link_expired`;

/** The link of the latest mail to the address, on the test's server. */
async function mailedLink(to: string): Promise<{ link: URL; subject: string }> {
  const { text, subject } = await readMailpit({ to });
  const mailed = new URL(/https?:\/\/\S+/.exec(text)?.[0] ?? "");
  return { link: new URL(mailed.pathname + mailed.search, origin), subject };
}

/** Requests a link and follows it: the session cookie, `name=value`. */
async function signIn(email: string): Promise<string> {
  await auth.requestMagicLink({ email, redirectTo: "/w/acme" });
  const response = await open((await mailedLink(email)).link);
  assert.equal(response.headers.get("location"), "/w/acme");
  return response.headers.getSetCookie()[0]?.split(";")[0] ?? "";
}

test("the link mail lands in Mailpit with its key's subject; the link works once, then expires", async (t) => {
  const ada = address("ada");
  await auth.requestMagicLink({ email: ada, redirectTo: "/w/acme" });
  const { link, subject } = await mailedLink(ada);
  assert.equal(subject, renderMail("identity.mail.sign_in", { url: "" }, defaultLocale()).subject);
  const first = await open(link);
  assert.deepEqual([first.status, first.headers.get("location")], [303, "/w/acme"]);
  assert.equal(first.headers.getSetCookie().length, 1);
  const again = await open(link);
  assert.deepEqual([again.status, again.headers.get("location")], [303, expired]);
  const bao = address("bao");
  await auth.requestMagicLink({ email: bao, redirectTo: "/" });
  const late = (await mailedLink(bao)).link;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + AUTH_LINK_TTL_MS + 1000 });
  const answer = await open(late);
  assert.deepEqual([answer.headers.get("location"), answer.headers.getSetCookie()], [expired, []]);
});

test("a refused email answers auth_invite_required: no users row, no verification, no mail", async () => {
  const eve = address("eve");
  await assert.rejects(auth.requestMagicLink({ email: eve, redirectTo: "/" }), (error) => {
    assert.ok(isAppError(error) && error.code === "auth_invite_required");
    return true;
  });
  assert.equal(await db().user.count({ where: { email: eve } }), 0);
  assert.equal(await db().verification.count(), 0);
  assert.deepEqual(
    sent.filter((mail) => mail.to === eve),
    [],
  );
});

test("sessions and links are stored under the SHA-256 of their token, never the token", async () => {
  const ada = address("ada");
  const cookie = await signIn(ada);
  const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).split(".")[0] ?? "";
  const [session, ...more] = await db().session.findMany();
  assert.deepEqual(more, []);
  assert.match(session?.id ?? "", /^ses_/);
  assert.equal(session?.token, digest(token));
  await auth.requestMagicLink({ email: ada, redirectTo: "/" });
  const { link } = await mailedLink(ada);
  const linkToken = link.searchParams.get("token") ?? "";
  const [verification] = await db().verification.findMany();
  assert.ok(linkToken && !verification?.identifier.includes(linkToken), "no link token stored");
});

test("revokeUser ends the user's sessions and sets disabled_at; the disabled user gets no link", async () => {
  const ada = address("ada");
  const cookie = await signIn(ada);
  const principal = await auth.resolvePrincipal({ headers: { cookie } });
  assert.match(principal?.userId ?? "", /^usr_/);
  await auth.revokeUser(principal?.userId ?? "");
  assert.equal(await auth.resolvePrincipal({ headers: { cookie } }), null);
  assert.ok((await db().user.findUnique({ where: { email: ada } }))?.disabledAt);
  // A users store this adapter never saw revoke anyone: the refusal comes from disabled_at.
  await auth.configure({ ...hooks, users: { ...hooks.users } });
  await assert.rejects(auth.requestMagicLink({ email: ada, redirectTo: "/" }), (error) => {
    assert.ok(isAppError(error) && error.code === "auth_invite_required");
    return true;
  });
  assert.equal(sent.filter((mail) => mail.to === ada).length, 1);
});

test("a dot segment or a backslash in the path is no route of the adapter's: the request goes to next()", async () => {
  /** The status line answering a GET of the target as written, which fetch would normalize. */
  const statusOf = (target: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(Number(new URL(origin).port), "127.0.0.1");
      const chunks: Buffer[] = [];
      socket.setTimeout(2000, () => socket.destroy()).on("error", () => socket.destroy());
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("close", () => resolve(Buffer.concat(chunks).toString().split("\r\n")[0] ?? ""));
      // write, not end: the server answers the route later, and closes the connection then.
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
  // The test server's next() answers 404; the route itself would answer 303.
  for (const path of ["/./api/auth/magic-link/verify", "/api\\auth\\magic-link\\verify"]) {
    assert.equal(await statusOf(`${path}?token=x`), "HTTP/1.1 404 Not Found", path);
  }
  assert.match(await statusOf("/api/auth/magic-link/verify?token=x"), /^HTTP\/1\.1 303 /);
});

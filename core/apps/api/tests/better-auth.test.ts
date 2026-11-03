// The Better Auth adapter behind the host on identity's hooks (alpha-p3-020): start() configures it
// with identity's authHooks, as the app does, and the link mail goes through the app-mail port to
// Mailpit, shared by every worktree, so each test mails an address of its own. The adapter runs on
// this file's schema and is handed to start(); the host's other tests run on the fake, which the
// test script pins.
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { authHooks, createInvite } from "@whytide/identity";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, isAppError } from "@whytide/platform";
import { AUTH_LINK_FAILED_PATH, authPort, getAdapter, type PortInstance } from "@whytide/providers";
import { readMailpit } from "@whytide/providers/app-mail/testing";
import { useAuthDatabase } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import { WINDOW_MS } from "../src/protection/rate-limit.ts";
import { type Api, start } from "../src/start.ts";

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
const modules: ModuleLoader[] = [
  { name: "tenancy", load: () => import("@whytide/tenancy") },
  { name: "identity", load: () => import("@whytide/identity") },
];
let auth: PortInstance<typeof authPort>;
let api: Api;

before(async () => {
  useAuthDatabase(asRole("app"));
  auth = await getAdapter(authPort, "better-auth");
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  // The /api/auth/* limit counts per address and minute: a minute no other run used.
  const minute = (Math.floor(Date.now() / WINDOW_MS) + randomInt(1_000, 1_000_000)) * WINDOW_MS;
  api = await start({
    port: 0,
    auth, // start() configures it with identity's authHooks
    log: createLogger({ destination: collectLogs().destination }),
    modules,
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
    now: () => minute,
  });
});
after(() => api?.close());

/** An address invited to a new workspace, of this test's own. */
async function invited(): Promise<string> {
  const [a] = await createTwoWorkspaces();
  const email = `ada-${randomUUID()}@example.com`;
  await createInvite({ workspaceId: a.workspace.id, email });
  return email;
}

/** Requests a link for the email: the newest mail's link, on this api, once it is not `seen`. */
async function linkFor(email: string, seen?: URL): Promise<URL> {
  await auth.requestMagicLink({ email, redirectTo: "/" });
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { text } = await readMailpit({ to: email });
    const mailed = new URL(/https?:\/\/\S+/.exec(text)?.[0] ?? "");
    const link = new URL(mailed.pathname + mailed.search, api.url);
    if (link.href !== seen?.href) return link;
    if (Date.now() > deadline) throw new Error("no new link in Mailpit");
    await delay(100);
  }
}

/** A link followed as the confirm page does: the POST from the app's own origin signs in. */
const follow = (link: URL) =>
  fetch(link, { method: "POST", redirect: "manual", headers: { origin: link.origin } });
const cookieOf = (response: Response) => response.headers.getSetCookie()[0]?.split(";")[0] ?? "";
const me = (cookie: string) => fetch(new URL("/v1/me", api.url), { headers: { cookie } });

test("the user a followed link creates has a usr_ id and is the user of GET /v1/me", async () => {
  const email = await invited();
  const followed = await follow(await linkFor(email));
  assert.equal(followed.status, 303);
  const res = await me(cookieOf(followed));
  const body = (await res.json()) as { user?: { id: string; email: string } };
  assert.equal(res.status, 200);
  assert.match(body.user?.id ?? "", /^usr_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(body.user?.email, email);
});

test("revokeUser on identity's hooks ends the sessions and sets disabled_at; the email gets no link, an old link fails", async () => {
  const email = await invited();
  const first = await linkFor(email);
  const cookie = cookieOf(await follow(first));
  assert.equal((await me(cookie)).status, 200);
  const old = await linkFor(email, first); // mailed before the revocation, never followed
  const { id } = await asRole("app").user.findUniqueOrThrow({ where: { email } });
  await auth.revokeUser(id);
  assert.equal((await me(cookie)).status, 401);
  const user = await asRole("app").user.findUniqueOrThrow({ where: { email } });
  assert.ok(user.disabledAt instanceof Date);
  // identity's hooks as a new users store, which the adapter's memory of revokeUser does not cover:
  // the refusals below come from disabled_at, as in another api process or after a restart.
  await auth.configure({ ...authHooks, users: { ...authHooks.users } });
  await assert.rejects(auth.requestMagicLink({ email, redirectTo: "/" }), (error) => {
    assert.ok(isAppError(error) && error.code === "auth_invite_required");
    return true;
  });
  const answer = await follow(old);
  const expired = `${AUTH_LINK_FAILED_PATH}?code=auth_link_expired`;
  assert.deepEqual([answer.headers.get("location"), answer.headers.getSetCookie()], [expired, []]);
});

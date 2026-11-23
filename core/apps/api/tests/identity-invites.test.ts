// identity's invites routes end to end (gamma-p6-020; core/modules/identity/README.md "Invites"): the
// host started with tenancy and identity, whose `api` it mounts under
// /v1/workspaces/:workspaceId/identity and whose `accountApi` under /v1, on the fake authentication
// adapter and the app-mail fake, in a schema of the worktree's database, answering real HTTP, the
// module's clock moved by the tests. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import type { Api } from "../src/start.ts";

const ORIGIN = "https://app.whytide.test";
// The host and the app-mail port read them as their configs load: set before either is imported.
process.env.APP_PUBLIC_ORIGIN = ORIGIN;
process.env.PROVIDER_APP_MAIL = "fake";
const { start } = await import("../src/start.ts");
const { authHooks } = await import("@whytide/identity");
const { useIdentityClient, useIdentityClock } = await import("@whytide/identity/testing");
const { collectLogs, createLogger } = await import("@whytide/platform");
const { appMailPort, getAdapter } = await import("@whytide/providers");
const { signInAs } = await import("@whytide/providers/auth/testing");
const { createMembership, createTwoWorkspaces, createUser, useTenancyClient } = await import(
  "@whytide/tenancy/testing"
);

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
const logs = collectLogs();
type AppMailFake = {
  read(query: { to: string }): Promise<{ subject: string; text: string }>;
  sent(): readonly { to: string }[];
  failNext(code: string): void;
};
const mails = (await getAdapter(appMailPort, "fake")) as unknown as AppMailFake;
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: logs.destination }),
    modules: [
      { name: "tenancy", load: () => import("@whytide/tenancy") },
      { name: "identity", load: () => import("@whytide/identity") },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());
afterEach(() => useIdentityClock(undefined));

const T0 = new Date("2026-11-12T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (time: Date) => useIdentityClock(() => time);
type Answer = { status: number; body: any };

/** A call from the app as the user to /v1/<path>; a POST with an Idempotency-Key of its own. */
async function call(user: string, method: string, path: string, body?: unknown): Promise<Answer> {
  const cookie = signInAs(user)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, "sec-fetch-site": "same-origin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = randomUUID();
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(new URL(`/v1/${path}`, api.url), { method, headers, body: json });
  const text = await res.text();
  return { status: res.status, body: text === "" ? text : JSON.parse(text) };
}
const invites = (ws: string) => `workspaces/${ws}/identity/invites`;
const mailsTo = (to: string) => mails.sent().filter((mail) => mail.to === to).length;
const refused = (status: number, code: string, details?: unknown) => ({
  status,
  body: details === undefined ? { code } : { code, details },
});
const FORBIDDEN = refused(403, "forbidden");
const NOT_FOUND = refused(404, "invite_not_found");

test("an Owner invites as Member: one open invite and one mail with the workspace, the inviter, the role, the expiry and /invitations; the refusals; a Member and another workspace are 403", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const kai = await createUser();
  await createMembership({ userId: kai.id, workspaceId: ws, role: "Member" });
  at(T0);

  const made = await call(a.user.id, "POST", invites(ws), {
    email: "Ann@Example.test",
    role: "Member",
  });
  assert.equal(made.status, 201);
  const { id, createdAt, ...invite } = made.body.invite;
  assert.deepEqual([made.body.mail, made.body.mailCode], ["sent", undefined]);
  assert.deepEqual(invite, {
    email: "ann@example.test",
    role: "Member",
    state: "open",
    invitedBy: a.user.id,
    expiresAt: new Date(T0.getTime() + 7 * DAY).toISOString(),
    mailedAt: T0.toISOString(),
  });
  const mail = await mails.read({ to: "ann@example.test" });
  assert.equal(mail.subject, `${a.user.displayName} invited you to ${a.workspace.name} on Whytide`);
  assert.deepEqual(mail.text.match(/https?:\/\/\S+/g), [`${ORIGIN}/invitations`]);
  for (const part of [a.workspace.name, "as a Member", "ann@example.test", "November 19, 2026"]) {
    assert.ok(mail.text.includes(part), part);
  }
  assert.doesNotMatch(mail.text, /token|\/api\/auth|sign-in/i);
  const listed = await call(a.user.id, "GET", invites(ws));
  // The days an invite stays open, IDENTITY_INVITE_TTL_DAYS unset (env-settings-b).
  const body = { invites: [{ id, createdAt, ...invite }], ttlDays: 7 };
  assert.deepEqual(listed, { status: 200, body });

  const as = (body: object) => call(a.user.id, "POST", invites(ws), body);
  assert.deepEqual(
    await as({ email: "ann@example.test", role: "Owner" }),
    refused(409, "invite_exists"),
  );
  assert.deepEqual(await as({ email: kai.email, role: "Member" }), refused(409, "already_member"));
  const role = { fields: ["role"] };
  assert.deepEqual(
    await as({ email: "bo@example.test", role: "Admin" }),
    refused(400, "validation_failed", role),
  );
  const email = { fields: ["email"] };
  assert.deepEqual(
    await as({ email: "not an email", role: "Member" }),
    refused(400, "identity_input_invalid", email),
  );
  assert.equal(
    (await as({ email: "bo@example.test", role: "Member", note: "strict" })).status,
    400,
  );

  for (const user of [kai.id, b.user.id]) {
    assert.deepEqual(await call(user, "GET", invites(ws)), FORBIDDEN);
    assert.deepEqual(
      await call(user, "POST", invites(ws), { email: "cy@example.test", role: "Member" }),
      FORBIDDEN,
    );
    assert.deepEqual(await call(user, "POST", `${invites(ws)}/${id}/revoke`), FORBIDDEN);
  }
  assert.equal(await app.invite.count({ where: { workspaceId: ws } }), 1);
  assert.equal(mailsTo("ann@example.test"), 1);
  // No log line carries an invited email.
  assert.ok(!logs.raw.join("").includes("@example.test"), "an email in the logs");
});

test("revoke and renew: a revoked invite lets no one in, and inviting again renews and mails it; an expired one too; an accepted one is invite_accepted; a failed or skipped mail keeps the invite", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const post = (email: string) => call(a.user.id, "POST", invites(ws), { email, role: "Member" });
  const revoke = (id: string) => call(a.user.id, "POST", `${invites(ws)}/${id}/revoke`);
  at(T0);
  const { id } = (await post("bo@example.test")).body.invite;

  const revoked = await revoke(id);
  assert.deepEqual([revoked.status, revoked.body.state], [200, "revoked"]);
  assert.deepEqual(await revoke(id), revoked);
  assert.equal(await authHooks.allowSignIn("bo@example.test"), false);
  const again = await post("bo@example.test");
  assert.deepEqual(
    [again.status, again.body.invite.id, again.body.invite.state],
    [201, id, "open"],
  );

  at(new Date(T0.getTime() + 7 * DAY));
  assert.equal((await call(a.user.id, "GET", invites(ws))).body.invites[0].state, "expired");
  assert.equal(await authHooks.allowSignIn("bo@example.test"), false);
  const renewed = await post("bo@example.test");
  assert.deepEqual(
    [renewed.body.invite.id, renewed.body.invite.state, renewed.body.mail],
    [id, "open", "sent"],
  );
  assert.equal(mailsTo("bo@example.test"), 3);
  assert.equal(await authHooks.allowSignIn("bo@example.test"), true);

  const accepted = (await post("cy@example.test")).body.invite.id;
  await authHooks.users.findOrCreateByEmail("cy@example.test"); // the first sign-in accepts it
  assert.deepEqual(await revoke(accepted), refused(409, "invite_accepted"));
  const theirs = await call(b.user.id, "POST", invites(b.workspace.id), {
    email: "di@example.test",
    role: "Member",
  });
  assert.deepEqual(await revoke(theirs.body.invite.id), NOT_FOUND);
  assert.deepEqual(await revoke("inv_missing"), NOT_FOUND);

  mails.failNext("mail_unreachable");
  const failed = await post("ed@example.test");
  const kept = [failed.status, failed.body.mail, failed.body.mailCode, failed.body.invite.mailedAt];
  assert.deepEqual(kept, [201, "failed", "mail_unreachable", null]);
  assert.equal(await authHooks.allowSignIn("ed@example.test"), true);
  process.env.APP_PUBLIC_ORIGIN = "";
  try {
    const skipped = await post("fay@example.test");
    assert.deepEqual(
      [skipped.status, skipped.body.mail, skipped.body.invite.state],
      [201, "skipped", "open"],
    );
  } finally {
    process.env.APP_PUBLIC_ORIGIN = ORIGIN;
  }
  assert.deepEqual([mailsTo("ed@example.test"), mailsTo("fay@example.test")], [0, 0]);
});

test("the Invitations routes: a user of another workspace sees their own open invite and accepts it as Member, a second accept answering the same; another user's id, an expired invite and no session are refused", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const kai = b.user; // an Owner of the other workspace
  at(T0);
  const { id, expiresAt } = (
    await call(a.user.id, "POST", invites(ws), { email: kai.email, role: "Member" })
  ).body.invite;

  const own = await call(kai.id, "GET", "invitations");
  const invitation = { id, workspaceName: a.workspace.name, role: "Member", expiresAt };
  assert.deepEqual(own.body, {
    invitations: [{ ...invitation, invitedByName: a.user.displayName }],
  });
  assert.deepEqual((await call(a.user.id, "GET", "invitations")).body, { invitations: [] });
  assert.deepEqual(await call(a.user.id, "POST", `invitations/${id}/accept`), NOT_FOUND);

  const landed = { status: 200, body: { workspaceId: ws, slug: a.workspace.slug } };
  assert.deepEqual(await call(kai.id, "POST", `invitations/${id}/accept`), landed);
  assert.deepEqual(await call(kai.id, "POST", `invitations/${id}/accept`), landed);
  const me = (await call(kai.id, "GET", "me")).body.memberships;
  const roles = me.map(({ workspaceId, role }: { workspaceId: string; role: string }) => [
    workspaceId,
    role,
  ]);
  assert.deepEqual(
    roles.sort(),
    [
      [b.workspace.id, "Owner"],
      [ws, "Member"],
    ].sort(),
  );
  assert.equal((await call(kai.id, "GET", `${invites(ws)}`)).status, 403, "a Member now");

  const ben = await createUser();
  await createMembership({ userId: ben.id, workspaceId: b.workspace.id, role: "Member" });
  const late = (await call(a.user.id, "POST", invites(ws), { email: ben.email, role: "Owner" }))
    .body;
  at(new Date(T0.getTime() + 7 * DAY));
  assert.deepEqual((await call(ben.id, "GET", "invitations")).body, { invitations: [] });
  assert.deepEqual(await call(ben.id, "POST", `invitations/${late.invite.id}/accept`), NOT_FOUND);
  const res = await fetch(new URL("/v1/invitations", api.url));
  assert.equal(res.status, 401);
});

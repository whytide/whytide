// identity's invites (gamma-p6-020; README.md "Invites"), on the worktree's database in this file's
// schema, the module's clock moved by the tests: the open rule, createInvite's new invites, renewals
// and refusals, revokeInvite and listInvites in a run of the workspace, sign-in counting open
// invites only, and acceptInvite by a user who has an account. The routes are the api's
// tests/identity-invites.test.ts; the command, tests/invite-cli.test.ts.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { listMemberships } from "@whytide/tenancy";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { acceptInvite, invitationsOf } from "../domain/accept.ts";
import { createInvite, listInvites, revokeInvite } from "../domain/invites.ts";
import { decideInvite, INVITE_TTL_MS, inviteState } from "../domain/rules.ts";
import { allowSignIn, findOrCreateByEmail } from "../domain/sign-in.ts";
import { useIdentityClient, useIdentityClock } from "../testing/index.ts";

withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
afterEach(() => useIdentityClock(undefined));

const T0 = new Date("2026-11-12T09:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
/** The module's time, from then on. */
const at = (time: Date) => useIdentityClock(() => time);
/** A run of the workspace, as the request's run of a route is. */
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal: servicePrincipal("identity_test") }, fn, { client: app });
const rowOf = (workspaceId: string, email: string) =>
  app.invite.findUniqueOrThrow({ where: { workspaceId_email: { workspaceId, email } } });
const code = (name: string, details?: unknown) =>
  details ? { code: name, details } : { code: name };

test("the open rule: open before its expiry, unless accepted or revoked; what inviting again does", () => {
  const open = { expiresAt: later(INVITE_TTL_MS), acceptedAt: null, revokedAt: null };
  assert.equal(inviteState(open, T0), "open");
  assert.equal(inviteState(open, later(INVITE_TTL_MS - 1)), "open");
  assert.equal(inviteState(open, later(INVITE_TTL_MS)), "expired");
  assert.equal(inviteState({ ...open, revokedAt: T0 }, T0), "revoked");
  assert.equal(inviteState({ ...open, acceptedAt: T0 }, T0), "accepted");
  assert.equal(decideInvite(null, false, T0), "create");
  assert.equal(decideInvite(open, false, T0), "invite_exists");
  assert.equal(decideInvite(open, true, T0), "invite_exists");
  assert.equal(decideInvite(null, true, T0), "already_member");
  assert.equal(decideInvite({ ...open, acceptedAt: T0 }, true, T0), "already_member");
  assert.equal(decideInvite({ ...open, acceptedAt: T0 }, false, T0), "renew");
  assert.equal(decideInvite({ ...open, revokedAt: T0 }, false, T0), "renew");
  assert.equal(decideInvite(open, false, later(INVITE_TTL_MS)), "renew");
});

test("createInvite: one open invite until IDENTITY_INVITE_TTL_DAYS later, with its role and inviter; refusals write nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  at(T0);
  const made = await createInvite({
    workspaceId: ws,
    email: " Kai@Example.TEST ",
    role: "Member",
    invitedBy: a.user.id,
  });
  const fields = { email: "kai@example.test", role: "Member", invitedBy: a.user.id };
  assert.deepEqual({ email: made.email, role: made.role, invitedBy: made.invitedBy }, fields);
  assert.deepEqual(made.expiresAt, later(INVITE_TTL_MS));
  assert.deepEqual(
    [made.acceptedAt, made.revokedAt, made.revokedBy, made.mailedAt],
    [null, null, null, null],
  );

  const again = {
    workspaceId: ws,
    email: "kai@example.test",
    role: "Owner",
    invitedBy: null,
  } as const;
  await assert.rejects(createInvite(again), code("invite_exists"));
  await assert.rejects(createInvite({ ...again, email: a.user.email }), code("already_member"));
  const role = { fields: ["role"] };
  await assert.rejects(
    createInvite({ ...again, email: "ann@example.test", role: "Admin" }),
    code("identity_input_invalid", role),
  );
  const email = { fields: ["email"] };
  await assert.rejects(
    createInvite({ ...again, email: "not an email" }),
    code("identity_input_invalid", email),
  );
  await assert.rejects(
    createInvite({ ...again, workspaceId: "wsp_missing" }),
    code("workspace_not_found"),
  );
  assert.equal(await app.invite.count(), 1);
  assert.deepEqual(await rowOf(ws, "kai@example.test"), made);
});

test("renewal: an expired, a revoked, and a removed member's accepted invite are renewed with a new expiry, role and inviter; two renewals at once make one", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const by = { workspaceId: ws, invitedBy: a.user.id } as const;
  at(T0);
  const expired = await createInvite({ ...by, email: "exp@example.test", role: "Member" });
  const revoked = await createInvite({ ...by, email: "rev@example.test", role: "Member" });
  const left = await createInvite({ ...by, email: "left@example.test", role: "Member" });
  await inRun(ws, () => revokeInvite(revoked.id, a.user.id));
  const user = await findOrCreateByEmail("left@example.test"); // the first sign-in accepts it
  await app.membership.updateMany({
    where: { workspaceId: ws, userId: user.id },
    data: { removedAt: T0, removedBy: a.user.id },
  });

  const now = later(INVITE_TTL_MS);
  at(now);
  const owner = await createUser();
  for (const old of [expired, revoked, left]) {
    const renewed = await createInvite({
      workspaceId: ws,
      email: old.email,
      role: "Owner",
      invitedBy: owner.id,
    });
    assert.equal(renewed.id, old.id, old.email);
    assert.deepEqual(
      [
        renewed.role,
        renewed.invitedBy,
        renewed.expiresAt,
        renewed.acceptedAt,
        renewed.revokedAt,
        renewed.revokedBy,
      ],
      ["Owner", owner.id, later(2 * INVITE_TTL_MS), null, null, null],
      old.email,
    );
  }
  assert.equal(await app.invite.count({ where: { workspaceId: ws } }), 3);
  // The removed member signs in again: active again, with the renewed invite's role.
  await findOrCreateByEmail("left@example.test");
  assert.deepEqual(
    (await listMemberships(user.id)).map(({ workspaceId, role }) => [workspaceId, role]),
    [[ws, "Owner"]],
  );

  at(later(3 * INVITE_TTL_MS));
  const both = await Promise.allSettled(
    [owner.id, a.user.id].map((invitedBy) =>
      createInvite({ workspaceId: ws, email: "exp@example.test", role: "Member", invitedBy }),
    ),
  );
  const outcomes = both.map((one) =>
    one.status === "fulfilled" ? "renewed" : (one.reason as { code?: string }).code,
  );
  assert.deepEqual(outcomes.sort(), ["invite_exists", "renewed"]);
});

test("revokeInvite and listInvites, in a run of the workspace: revoked once, unchanged again; accepted, another workspace's or an unknown id refused", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  at(T0);
  const by = { workspaceId: ws, role: "Member", invitedBy: a.user.id } as const;
  const first = await createInvite({ ...by, email: "first@example.test" });
  at(later(1_000));
  await createInvite({ ...by, email: "second@example.test" });
  at(later(2_000));
  const accepted = await createInvite({ ...by, email: "accepted@example.test" });
  await findOrCreateByEmail("accepted@example.test");
  const theirs = await createInvite({
    ...by,
    workspaceId: b.workspace.id,
    email: "b@example.test",
  });

  at(later(3_000));
  const revoked = await inRun(ws, () => revokeInvite(first.id, a.user.id));
  assert.deepEqual([revoked.revokedAt, revoked.revokedBy], [later(3_000), a.user.id]);
  at(later(4_000));
  assert.deepEqual(await inRun(ws, () => revokeInvite(first.id, b.user.id)), revoked);
  await assert.rejects(
    inRun(ws, () => revokeInvite(accepted.id, a.user.id)),
    code("invite_accepted"),
  );
  for (const id of [theirs.id, "inv_missing", ""]) {
    await assert.rejects(
      inRun(ws, () => revokeInvite(id, a.user.id)),
      code("invite_not_found"),
      id,
    );
  }
  assert.equal((await rowOf(b.workspace.id, "b@example.test")).revokedAt, null);

  // Not accepted, the latest made first; the second open until a millisecond before its expiry.
  at(later(INVITE_TTL_MS + 999));
  const listed = await inRun(ws, () => listInvites());
  assert.deepEqual(
    listed.map(({ email, state }) => [email, state]),
    [
      ["second@example.test", "open"],
      ["first@example.test", "revoked"],
    ],
  );
  at(later(INVITE_TTL_MS + 1_000));
  assert.equal((await inRun(ws, () => listInvites()))[0]?.state, "expired");
});

test("sign-in counts open invites only: an expired or a revoked one lets no one in and makes nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  at(T0);
  const by = { workspaceId: ws, role: "Member", invitedBy: a.user.id } as const;
  await createInvite({ ...by, email: "late@example.test" });
  const revoked = await createInvite({ ...by, email: "gone@example.test" });
  await inRun(ws, () => revokeInvite(revoked.id, a.user.id));
  assert.equal(await allowSignIn("late@example.test"), true);
  assert.equal(await allowSignIn("gone@example.test"), false);

  at(later(INVITE_TTL_MS));
  for (const email of ["late@example.test", "gone@example.test"]) {
    assert.equal(await allowSignIn(email), false, email);
    await assert.rejects(findOrCreateByEmail(email), code("invite_required"), email);
  }
  assert.equal(
    await app.user.count({ where: { email: { in: ["late@example.test", "gone@example.test"] } } }),
    0,
  );
  const invites = await app.invite.findMany({
    where: { workspaceId: ws },
    select: { acceptedAt: true },
  });
  assert.deepEqual(invites, [{ acceptedAt: null }, { acceptedAt: null }]);
});

test("acceptInvite: the user's own open invite makes the membership with its role, a second answers the same; any other id is invite_not_found and makes nothing", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const kai = b.user; // an Owner of the other workspace, with an account
  at(T0);
  const by = { workspaceId: ws, role: "Member", invitedBy: a.user.id } as const;
  const invite = await createInvite({ ...by, email: kai.email });
  const other = await createInvite({ ...by, email: "other@example.test" });
  const listed = await invitationsOf(kai.id);
  assert.deepEqual(listed, [
    {
      id: invite.id,
      workspaceName: a.workspace.name,
      role: "Member",
      invitedByName: a.user.displayName,
      expiresAt: later(INVITE_TTL_MS),
    },
  ]);
  for (const id of [other.id, "inv_missing", ""]) {
    await assert.rejects(
      acceptInvite({ inviteId: id, userId: kai.id }),
      code("invite_not_found"),
      id,
    );
  }
  assert.equal((await listMemberships(kai.id)).length, 1);

  const landed = { workspaceId: ws, slug: a.workspace.slug };
  assert.deepEqual(await acceptInvite({ inviteId: invite.id, userId: kai.id }), landed);
  assert.deepEqual(await acceptInvite({ inviteId: invite.id, userId: kai.id }), landed);
  const roles = (await listMemberships(kai.id)).map(({ workspaceId, role }) => [workspaceId, role]);
  assert.deepEqual(
    roles.sort(),
    [
      [b.workspace.id, "Owner"],
      [ws, "Member"],
    ].sort(),
  );
  assert.deepEqual(await invitationsOf(kai.id), []);
  // Another user may not accept it, nor its accepted id answer them.
  await assert.rejects(
    acceptInvite({ inviteId: invite.id, userId: a.user.id }),
    code("invite_not_found"),
  );

  // Expired or revoked, an invite is not open: not listed, not accepted.
  const ben = await createUser();
  await createMembership({ userId: ben.id, workspaceId: b.workspace.id, role: "Member" });
  const late = await createInvite({ ...by, email: ben.email });
  at(later(INVITE_TTL_MS));
  assert.deepEqual(await invitationsOf(ben.id), []);
  await assert.rejects(
    acceptInvite({ inviteId: late.id, userId: ben.id }),
    code("invite_not_found"),
  );
  const renewed = await createInvite({ ...by, email: ben.email });
  await inRun(ws, () => revokeInvite(renewed.id, a.user.id));
  await assert.rejects(
    acceptInvite({ inviteId: late.id, userId: ben.id }),
    code("invite_not_found"),
  );
  assert.deepEqual(
    (await listMemberships(ben.id)).map(({ workspaceId }) => workspaceId),
    [b.workspace.id],
  );
});

// tenancy's members (gamma-p6-030; README.md "Members") on the worktree's database, in this file's
// schema: listMembers, changeRole, removeMember and findActiveMembership in a tenant run, as the
// api's routes run them; the order of the refusals; the event in the outbox, in the removal's
// transaction and once; addMember making a removed membership active again; every read of
// memberships skipping a removed one; and two Owners demoting each other at once, on two
// connections: the second waits on the first's lock, then refuses, and one Owner is left.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { tenantClient, withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import {
  addMember,
  changeRole,
  findActiveMembership,
  listMembers,
  listMemberships,
  removeMember,
  resolveMembership,
  upsertUser,
  workspaceOwner,
} from "../domain/commands.ts";
import { createMembership, createTwoWorkspaces, useTenancyClient } from "../testing/index.ts";

withTestDb();
const app = asRole("app");
useTenancyClient(app);
const principal = servicePrincipal("tenancy_test");

/** `fn` in a tenant run of the workspace, as the api host runs a route's handler. */
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app, timeout: 30_000 });
const fails = (code: string, details?: unknown) => (error: unknown) => {
  assert.ok(isAppError(error), String(error));
  assert.equal(error.code, code);
  if (details !== undefined) assert.deepEqual(error.details, details);
  return true;
};
/** A user with the email and name, a member of the workspace with the role. */
async function member(workspaceId: string, email: string, role: "Owner" | "Member", name?: string) {
  const user = await upsertUser({ email, ...(name === undefined ? {} : { displayName: name }) });
  return { user, membership: await createMembership({ userId: user.id, workspaceId, role }) };
}
const events = () =>
  app.$queryRaw<{ event_name: string; payload: unknown; same: boolean }[]>`
    SELECT o.event_name, o.payload, o.xmin = m.xmin AS same
    FROM outbox o JOIN memberships m ON m.id = o.payload->>'membershipId' ORDER BY o.created_at`;

test("listMembers: the run's workspace's active members with their email and name, Owners first, then by name", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  await app.user.update({ where: { id: a.user.id }, data: { displayName: "Ada Owner" } });
  const zoe = await member(ws, "zoe@example.com", "Member", "Zoe Adams");
  const bob = await member(ws, "bob@example.com", "Member", "bob Brown");
  const carol = await member(ws, "carol@example.com", "Owner", "Carol Chen");
  const dan = await member(ws, "dan@example.com", "Member");
  const eve = await member(ws, "eve@example.com", "Member", "Eve Gone");
  await inRun(ws, () => removeMember({ membershipId: eve.membership.id, removedBy: a.user.id }));

  const listed = await inRun(ws, () => listMembers());
  const names = listed.map(({ displayName, email }) => displayName ?? email);
  assert.deepEqual(names, ["Ada Owner", "Carol Chen", "bob Brown", "dan@example.com", "Zoe Adams"]);
  assert.deepEqual(listed[1], {
    membershipId: carol.membership.id,
    userId: carol.user.id,
    email: "carol@example.com",
    displayName: "Carol Chen",
    role: "Owner",
    joinedAt: carol.membership.createdAt,
  });
  const roles = listed.map(({ membershipId, role }) => [membershipId, role]);
  assert.deepEqual(roles.slice(2), [
    [bob.membership.id, "Member"],
    [dan.membership.id, "Member"],
    [zoe.membership.id, "Member"],
  ]);
  const other = await inRun(b.workspace.id, () => listMembers());
  assert.deepEqual(
    other.map(({ membershipId }) => membershipId),
    [b.membership.id],
  );
});

test("changeRole: Owner and Member only; refused in order, membership_not_found, member_is_self, last_owner; the same role unchanged; a Member made Owner and back", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const kai = await member(ws, "kai@example.com", "Member", "Kai");
  const change = (membershipId: string, role: "Owner" | "Member", changedBy = a.user.id) =>
    inRun(ws, () => changeRole({ membershipId, role, changedBy }));

  for (const role of ["Admin", "Guest", ""]) {
    const input = { membershipId: kai.membership.id, role: role as "Owner", changedBy: a.user.id };
    const refused = fails("tenancy_input_invalid", { fields: ["role"] });
    await assert.rejects(
      inRun(ws, () => changeRole(input)),
      refused,
    );
  }
  await assert.rejects(change("mem_missing", "Owner"), fails("membership_not_found"));
  await assert.rejects(change(b.membership.id, "Member"), fails("membership_not_found"));
  // The caller's own row, also the last Owner's: member_is_self comes first.
  await assert.rejects(change(a.membership.id, "Member"), fails("member_is_self"));
  await assert.rejects(change(a.membership.id, "Member", kai.user.id), fails("last_owner"));

  const promoted = await change(kai.membership.id, "Owner");
  assert.deepEqual(
    [promoted.membershipId, promoted.role, promoted.email],
    [kai.membership.id, "Owner", "kai@example.com"],
  );
  const demoted = await change(kai.membership.id, "Member");
  assert.equal(demoted.role, "Member");
  const [before] = await app.$queryRaw<{ xmin: string }[]>`
    SELECT xmin::text FROM memberships WHERE id = ${kai.membership.id}`;
  assert.deepEqual(await change(kai.membership.id, "Member"), demoted, "the same role, unchanged");
  const [after] = await app.$queryRaw<{ xmin: string }[]>`
    SELECT xmin::text FROM memberships WHERE id = ${kai.membership.id}`;
  assert.equal(after?.xmin, before?.xmin, "no write for the same role");

  await inRun(ws, () => removeMember({ membershipId: kai.membership.id, removedBy: a.user.id }));
  // A removed one is not found, before member_is_self: the caller's own removed row too.
  await assert.rejects(change(kai.membership.id, "Owner"), fails("membership_not_found"));
  await assert.rejects(
    change(kai.membership.id, "Owner", kai.user.id),
    fails("membership_not_found"),
  );
});

test("removeMember: removed_at and removed_by set, one tenancy.member_removed with ids only in the same transaction; again, unchanged and no second event; refused in order", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const kai = await member(ws, "kai@example.com", "Member", "Kai");
  const remove = (membershipId: string, removedBy = a.user.id) =>
    inRun(ws, () => removeMember({ membershipId, removedBy }));

  await assert.rejects(remove("mem_missing"), fails("membership_not_found"));
  await assert.rejects(remove(b.membership.id), fails("membership_not_found"));
  await assert.rejects(remove(a.membership.id), fails("member_is_self"));
  await assert.rejects(remove(a.membership.id, kai.user.id), fails("last_owner"));
  await assert.rejects(
    inRun(ws, () => removeMember({ membershipId: kai.membership.id, removedBy: "" })),
    fails("tenancy_input_invalid", { fields: ["removedBy"] }),
  );
  assert.deepEqual(await events(), [], "a refusal writes no event");

  const removed = await remove(kai.membership.id);
  assert.ok(removed.removedAt instanceof Date);
  assert.deepEqual(
    [removed.id, removed.removedBy, removed.role],
    [kai.membership.id, a.user.id, "Member"],
  );
  const payload = { workspaceId: ws, membershipId: kai.membership.id, userId: kai.user.id };
  const event = { event_name: "tenancy.member_removed", payload, same: true };
  assert.deepEqual(await events(), [event]);

  assert.deepEqual(await remove(kai.membership.id), removed, "again: unchanged");
  assert.deepEqual(await events(), [event], "again: no second event");

  // Both or neither: the CHECK refuses a removal without its remover, whoever writes it.
  const half = app.$executeRaw`UPDATE memberships SET removed_at = now() WHERE id = ${b.membership.id}`;
  assert.equal(await sqlstate(half), "23514");
});

test("addMember makes a removed membership active again with the role given; findActiveMembership answers null for a removed member and for another workspace's", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const kai = await member(ws, "kai@example.com", "Member", "Kai");
  const active = (userId: string, workspaceId = ws) =>
    inRun(workspaceId, () => findActiveMembership(userId));

  assert.deepEqual(await active(kai.user.id), kai.membership);
  assert.equal(await active(b.user.id), null, "another workspace's member");
  await assert.rejects(active(""), fails("tenancy_input_invalid", { fields: ["userId"] }));
  await inRun(ws, () => removeMember({ membershipId: kai.membership.id, removedBy: a.user.id }));
  assert.equal(await active(kai.user.id), null, "a removed member");

  const back = await addMember({ userId: kai.user.id, workspaceId: ws, role: "Owner" });
  const { id, role, removedAt, removedBy, createdAt } = back;
  assert.deepEqual(
    [id, role, removedAt, removedBy, createdAt],
    [kai.membership.id, "Owner", null, null, kai.membership.createdAt],
  );
  assert.deepEqual(await active(kai.user.id), back);
  // An active membership stays as it is, its role included.
  assert.deepEqual(await addMember({ userId: kai.user.id, workspaceId: ws, role: "Member" }), back);
  assert.equal(await active(kai.user.id, b.workspace.id), null);
});

test("every read of memberships skips a removed one: listMemberships, resolveMembership by id and by slug, workspaceOwner", async () => {
  const [a, b] = await createTwoWorkspaces();
  await createMembership({ userId: a.user.id, workspaceId: b.workspace.id, role: "Member" });
  const second = await member(a.workspace.id, "second@example.com", "Owner", "Second Owner");
  const resolve = (workspaceIdOrSlug: string) =>
    resolveMembership({ userId: a.user.id, workspaceIdOrSlug });
  assert.equal((await listMemberships(a.user.id)).length, 2);
  assert.equal(await inRun(a.workspace.id, () => workspaceOwner(a.workspace.id)), a.user.id);

  const removedBy = second.user.id;
  await inRun(a.workspace.id, () => removeMember({ membershipId: a.membership.id, removedBy }));
  const listed = await listMemberships(a.user.id);
  assert.deepEqual(
    listed.map(({ workspaceId, role }) => [workspaceId, role]),
    [[b.workspace.id, "Member"]],
  );
  assert.equal(await resolve(a.workspace.id), null);
  assert.equal(await resolve(a.workspace.slug), null);
  assert.equal((await resolve(b.workspace.slug))?.workspaceId, b.workspace.id);
  assert.equal(
    await inRun(a.workspace.id, () => workspaceOwner(a.workspace.id)),
    second.user.id,
    "the oldest active Owner",
  );
});

test("two Owners demoting each other at once: the second waits on the first's lock, then refuses with last_owner, and one Owner is left", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const ben = await member(ws, "ben@example.com", "Owner", "Ben");
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = () => {};
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  const first = inRun(ws, async () => {
    const changed = await changeRole({
      membershipId: ben.membership.id,
      role: "Member",
      changedBy: a.user.id,
    });
    held();
    await released;
    return changed;
  });
  await holding;
  let pid = 0;
  const second = inRun(ws, async () => {
    const [own] = await tenantClient.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    pid = own?.pid ?? 0;
    return changeRole({ membershipId: a.membership.id, role: "Member", changedBy: ben.user.id });
  });
  const settled = second.then(
    () => "changed",
    (error: unknown) => error,
  );
  try {
    const deadline = Date.now() + 10_000;
    let wait: string | null = null;
    while (wait !== "Lock" && Date.now() < deadline) {
      await delay(20);
      if (pid === 0) continue;
      const [row] = await app.$queryRaw<{ wait: string | null }[]>`
        SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = ${pid}::int`;
      wait = row?.wait ?? null;
    }
    assert.equal(wait, "Lock", "the second change waits on the first's lock");
  } finally {
    release();
  }
  assert.equal((await first).role, "Member");
  assert.ok(fails("last_owner")(await settled));
  const owners = await app.membership.findMany({
    where: { workspaceId: ws, role: "Owner", removedAt: null },
    select: { id: true },
  });
  assert.deepEqual(owners, [{ id: a.membership.id }]);
});

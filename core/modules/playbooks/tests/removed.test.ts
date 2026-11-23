// A removed member's agents (gamma-p6-075; README "A removed member"), in this file's schema:
// tenancy's removeMember publishes tenancy.member_removed, and one pass of the outbox's delivery, as
// the worker's, runs playbooks' subscriber in a tenant run of the workspace. The removed user's
// agents there that are not archived turn paused with member_removed, one playbooks.playbook_updated
// each, an agent they paused taking the new reason; an archived agent, a teammate's and their agent
// in another workspace stay as they were; a redelivery writes and publishes nothing; no log line of
// the delivery holds the member's email or name. Then the pause's reason through updatePlaybook: a
// pause is the member's, an agent paused already keeps its reason, and only the owner resumes one
// paused for their removal; and the CHECK that sets the reason exactly while paused.
import assert from "node:assert/strict";
import test from "node:test";
import { createOutboxStore, type TenantClient, withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import {
  collectLogs,
  createLogger,
  deliverPending,
  isAppError,
  type Principal,
  servicePrincipal,
} from "@whytide/platform";
import { removeMember } from "@whytide/tenancy";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { updatePlaybook } from "../domain/playbooks.ts";
import "../events.ts";
import { createPlaybook } from "../testing/index.ts";

withTestDb();
const app = asRole("app");
useTenancyClient(app);
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const worker = servicePrincipal("worker");
const UPDATED = "playbooks.playbook_updated";

/** One pass of the worker's delivery, each handler in a tenant run of the event's workspace. */
async function deliver(): Promise<void> {
  const report = await deliverPending({
    store: createOutboxStore(app),
    runInTenant: (workspaceId, fn) =>
      withTenant({ workspaceId, principal: worker }, fn, { client: app }),
    log,
  });
  assert.deepEqual([report.retried, report.dead], [0, 0], "every event delivered");
}

/** Each agent's status, reason and last write, by id. */
async function rows(ids: readonly string[]) {
  const found = await app.playbook.findMany({ where: { id: { in: [...ids] } } });
  return new Map(found.map((row) => [row.id, row]));
}
/** The payloads of playbooks.playbook_updated, by workspace. */
async function updates(workspaceId: string) {
  const where = { workspaceId, eventName: UPDATED };
  const found = await app.outboxEntry.findMany({ where, orderBy: { id: "asc" } });
  return found.map((row) => row.payload);
}

test("removing a member pauses their agents in the workspace that are not archived with member_removed, one playbook_updated each, their own pause taken over; an archived agent, a teammate's and theirs in another workspace stay; a redelivery writes nothing; no log line names them", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const [member, teammate] = [await createUser(), await createUser()];
  const membership = await createMembership({ userId: member.id, workspaceId: ws, role: "Member" });
  await createMembership({ userId: teammate.id, workspaceId: ws, role: "Member" });
  await createMembership({ userId: member.id, workspaceId: b.workspace.id, role: "Member" });
  const agent = (workspaceId: string, ownerUserId: string, icpId: string, status = "active") =>
    createPlaybook({ workspaceId, ownerUserId, icpId, status: status as "active" });
  const active = await agent(ws, member.id, "icp_active");
  const paused = await agent(ws, member.id, "icp_paused", "paused");
  const archived = await agent(ws, member.id, "icp_archived", "archived");
  const theirs = await agent(ws, teammate.id, "icp_teammate");
  const elsewhere = await agent(b.workspace.id, member.id, "icp_elsewhere");

  const removal = { membershipId: membership.id, removedBy: a.user.id };
  await withTenant({ workspaceId: ws, principal: worker }, () => removeMember(removal), {
    client: app,
  });
  await deliver();

  const ids = [active, paused, archived, theirs, elsewhere];
  const after = await rows(ids);
  const state = (id: string) => [after.get(id)?.status, after.get(id)?.pausedReason];
  assert.deepEqual(state(active), ["paused", "member_removed"]);
  assert.deepEqual(state(paused), ["paused", "member_removed"], "their own pause taken over");
  assert.deepEqual(state(archived), ["archived", null]);
  assert.deepEqual(state(theirs), ["active", null]);
  assert.deepEqual(state(elsewhere), ["active", null]);
  const expected = [active, paused].sort().map((playbookId) => ({ playbookId, status: "paused" }));
  assert.deepEqual(await updates(ws), expected, "one event per agent moved, ids and status only");
  assert.deepEqual(await updates(b.workspace.id), []);

  // A redelivery: the marks lost after the handlers' commits, the rows delivered again.
  await asRole("owner").$executeRawUnsafe("UPDATE outbox SET delivered_at = NULL");
  await deliver();
  const again = await rows(ids);
  for (const id of ids) {
    assert.deepEqual(again.get(id)?.updatedAt, after.get(id)?.updatedAt, `${id} not written`);
  }
  assert.deepEqual(await updates(ws), expected, "a redelivery publishes nothing");

  const written = logs.raw.join("\n");
  for (const value of [member.email, member.displayName ?? member.email]) {
    assert.ok(!written.includes(value), "no log line holds the member's email or name");
  }
});

test("the pause's reason through updatePlaybook: a pause is the member's; an agent paused for its owner's removal keeps that reason on a pause or a rename, an Owner's resume is playbook_owner_removed and changes nothing, the owner resumes it; archiving clears the reason", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const owner: Principal = {
    userId: a.user.id,
    workspaceId: ws,
    actorType: "human",
    authMethod: "session",
    membershipId: a.membership.id,
    role: "Owner",
    scopes: [],
  };
  const member = await createUser();
  const asMember: Principal = {
    ...owner,
    userId: member.id,
    membershipId: "mem_member",
    role: "Member",
  };
  const run = <T>(principal: Principal, fn: (tx: TenantClient) => Promise<T>) =>
    withTenant({ workspaceId: ws, principal }, fn, { client: app });
  const reason = async (id: string) => {
    const row = await app.playbook.findUniqueOrThrow({ where: { id } });
    return [row.status, row.pausedReason];
  };

  const mine = await createPlaybook({ workspaceId: ws, ownerUserId: a.user.id, icpId: "icp_mine" });
  await run(owner, () => updatePlaybook(mine, { status: "paused" }));
  assert.deepEqual(
    await reason(mine),
    ["paused", "user"],
    "a pause through the PATCH is the member's",
  );
  await run(owner, () => updatePlaybook(mine, { status: "active" }));
  assert.deepEqual(await reason(mine), ["active", null]);

  const seeded = { workspaceId: ws, ownerUserId: member.id, icpId: "icp_hers" };
  const hers = await createPlaybook({
    ...seeded,
    status: "paused",
    pausedReason: "member_removed",
  });
  await run(owner, () => updatePlaybook(hers, { status: "paused", name: "Renamed" }));
  assert.deepEqual(await reason(hers), ["paused", "member_removed"], "a pause keeps the reason");
  const before = await app.playbook.findUniqueOrThrow({ where: { id: hers } });
  for (const patch of [{ status: "active" as const }, { status: "active" as const, name: "X" }]) {
    await assert.rejects(
      run(owner, () => updatePlaybook(hers, patch)),
      (error) =>
        isAppError(error) && error.code === "playbook_owner_removed" && error.status === 409,
    );
  }
  const unchanged = await app.playbook.findUniqueOrThrow({ where: { id: hers } });
  assert.deepEqual(unchanged, before, "nothing changed");
  await run(asMember, () => updatePlaybook(hers, { status: "active" }));
  assert.deepEqual(await reason(hers), ["active", null], "its owner resumes it");

  const gone = await createPlaybook({
    ...seeded,
    icpId: "icp_gone",
    status: "paused",
    pausedReason: "member_removed",
  });
  await run(owner, () => updatePlaybook(gone, { status: "archived" }));
  assert.deepEqual(
    await reason(gone),
    ["archived", null],
    "an Owner archives it, the reason cleared",
  );
});

test("the CHECK playbooks_paused_reason: a reason exactly while paused", async () => {
  const [a] = await createTwoWorkspaces();
  const id = await createPlaybook({
    workspaceId: a.workspace.id,
    ownerUserId: a.user.id,
    icpId: "x",
  });
  const write = (data: object) => app.playbook.update({ where: { id }, data });
  assert.equal(await sqlstate(write({ status: "paused" })), "23514", "paused without a reason");
  assert.equal(await sqlstate(write({ pausedReason: "user" })), "23514", "a reason while active");
  await write({ status: "paused", pausedReason: "member_removed" });
});

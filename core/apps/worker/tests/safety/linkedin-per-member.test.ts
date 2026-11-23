// Safety cases of each member's own account (gamma-p6-070; core/modules/linkedin/README.md "Kill
// switches", docs/security.md "Who may lift a pause"), on the LinkedIn fake and a schema of the
// slice's database (fixtures/linkedin-send.ts). Who may pause and lift is linkedin's domain's, by
// platform's can() for linkedin.manage, so each refusal here is the one the routes answer. Each case
// reserves a connection request first, then asserts the fake's recorded sends: a Member's refused
// unpause of a teammate's account, which an Owner paused; a Member's refused lift of the workspace's
// stop; an Owner's refused lift of the operator's pause; a removed member's account refusing the
// next reservation (and the step reserved before the removal at its call); and a Member pausing
// their own account.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  db,
  reserveSend,
  type Sender,
  sender,
  sends,
  useSendTests,
} from "../fixtures/linkedin-send.ts";

const { createOutboxStore, withTenant } = await import("@whytide/db");
const platform = await import("@whytide/platform");
// linkedin's and tenancy's code by their builds' paths, as the worker's loader imports the modules.
const built = (path: string) =>
  import(new URL(`../../../../modules/${path}`, import.meta.url).href);
type Controls = typeof import("../../../../modules/linkedin/dist/domain/controls/controls.js");
type Tenancy = typeof import("../../../../modules/tenancy/dist/index.js");
type TenancyTesting = typeof import("../../../../modules/tenancy/dist/testing/index.js");
const controls: Controls = await built("linkedin/dist/domain/controls/controls.js");
const tenancy: Tenancy = await built("tenancy/dist/index.js");
const tenancyTesting: TenancyTesting = await built("tenancy/dist/testing/index.js");
type Principal = import("@whytide/platform").Principal;
type Role = NonNullable<Principal["role"]>;

useSendTests();
const log = platform.createLogger({ destination: platform.collectLogs().destination });
const OPERATOR = "ops-anna";
const STOPPED = { refused: "account_stopped", retryAt: null };
const WORKSPACE_STOPPED = { refused: "workspace_stopped", retryAt: null };

/** A member of the account's workspace with the role, as the api's guard builds the principal. */
const as = (role: Role, userId: string, a: Sender): Principal => ({
  userId,
  actorType: "human",
  authMethod: "session",
  membershipId: `mem_${userId}`,
  workspaceId: a.workspaceId,
  role,
  scopes: [],
});
const failsWith = (code: string) => (error: unknown) =>
  platform.isAppError(error) && error.code === code;

/** The account's owner, as the fixture made it, and its stop: on, and by whom. */
const row = (a: Sender) => db().senderAccount.findUniqueOrThrow({ where: { id: a.accountId } });
const ownerOf = async (a: Sender) => (await row(a)).ownerUserId;
const switchOf = async (a: Sender) => {
  const { killSwitch, killSwitchSource } = await row(a);
  return [killSwitch, killSwitchSource];
};
/** The account's next connection request's reservation. */
const next = (a: Sender, idempotencyKey: string) =>
  a.run(() => reserveSend({ accountId: a.accountId, actionType: "invite", idempotencyKey }));

/** One pass of the worker's delivery, each handler in a tenant run of the event's workspace. */
async function deliver(): Promise<void> {
  const principal = platform.servicePrincipal("worker");
  const report = await platform.deliverPending({
    store: createOutboxStore(db()),
    runInTenant: (workspaceId, fn) => withTenant({ workspaceId, principal }, fn, { client: db() }),
    log,
  });
  assert.deepEqual([report.retried, report.dead], [0, 0], "every event delivered");
}

test("an Owner pauses a Member's account and a teammate Member's unpause of it is refused not_account_owner: the pause holds, the next reservation and the call of the step reserved before it are refused, and the fake records no send", async () => {
  const a = await sender();
  const step = await a.step("invite");
  const paused = await a.run(() =>
    controls.pauseAccount(a.accountId, as("Owner", "usr_workspace_owner", a)),
  );
  assert.deepEqual([paused.killSwitch, paused.killSwitchSource], [true, "tester"]);
  const teammate = as("Member", "usr_teammate", a);
  await assert.rejects(
    a.run(() => controls.unpauseAccount(a.accountId, teammate)),
    failsWith("not_account_owner"),
  );
  assert.deepEqual(await switchOf(a), [true, "tester"]);
  assert.deepEqual(await next(a, "after-teammate"), STOPPED);
  assert.deepEqual(await a.call("linkedin_send_invite", step.input()), STOPPED);
  assert.deepEqual(sends(), []);
});

test("a Member's lift of the workspace's stop is refused forbidden, the account's owner's too: the Owner's stop holds, the next reservation and the call of the step reserved before it are refused, and the fake records no send", async () => {
  const a = await sender();
  const step = await a.step("invite");
  await a.run(() => controls.setWorkspaceStop(true, as("Owner", "usr_workspace_owner", a)));
  const member = as("Member", await ownerOf(a), a);
  await assert.rejects(
    a.run(() => controls.setWorkspaceStop(false, member)),
    failsWith("forbidden"),
  );
  const where = { workspaceId: a.workspaceId };
  const stop = await db().linkedinWorkspaceControl.findFirstOrThrow({ where });
  assert.deepEqual([stop.stopped, stop.stopSource], [true, "tester"]);
  assert.deepEqual(await next(a, "after-member"), WORKSPACE_STOPPED);
  assert.deepEqual(await a.call("linkedin_send_invite", step.input()), WORKSPACE_STOPPED);
  assert.deepEqual(sends(), []);
});

test("an Owner's lift of the operator's pause is refused stopped_by_operator, the account's owner's too: the operator's pause holds, the next reservation and the call of the step reserved before it are refused, and the fake records no send", async () => {
  const a = await sender();
  const step = await a.step("invite");
  const paused = await controls.pauseAccountAsOperator(a.workspaceId, a.accountId, OPERATOR);
  assert.equal(paused, "changed");
  for (const principal of [
    as("Owner", "usr_workspace_owner", a),
    as("Member", await ownerOf(a), a),
  ]) {
    await assert.rejects(
      a.run(() => controls.unpauseAccount(a.accountId, principal)),
      failsWith("stopped_by_operator"),
    );
  }
  assert.deepEqual(await switchOf(a), [true, "operator"]);
  assert.deepEqual(await next(a, "after-owner"), STOPPED);
  assert.deepEqual(await a.call("linkedin_send_invite", step.input()), STOPPED);
  assert.deepEqual(sends(), []);
});

test("a removed member's account: the removal's event pauses it member_removed, its next reservation and the call of the step reserved before the removal are refused, an Owner cannot lift that pause, and the fake records no send", async () => {
  const a = await sender();
  const user = await tenancyTesting.createUser();
  const workspaceId = a.workspaceId;
  const member = await tenancyTesting.createMembership({
    userId: user.id,
    workspaceId,
    role: "Member",
  });
  await db().senderAccount.update({ where: { id: a.accountId }, data: { ownerUserId: user.id } });
  const step = await a.step("invite");
  const owner = await db().membership.findFirstOrThrow({ where: { workspaceId, role: "Owner" } });
  const removal = { membershipId: member.id, removedBy: owner.userId };
  await a.run(() => tenancy.removeMember(removal));
  await deliver();
  assert.deepEqual(await switchOf(a), [true, "member_removed"]);
  await assert.rejects(
    a.run(() => controls.unpauseAccount(a.accountId, as("Owner", owner.userId, a))),
    failsWith("not_account_owner"),
  );
  assert.deepEqual(await switchOf(a), [true, "member_removed"]);
  assert.deepEqual(await next(a, "after-removal"), STOPPED);
  assert.deepEqual(await a.call("linkedin_send_invite", step.input()), STOPPED);
  assert.deepEqual(sends(), []);
});

test("a Member pauses their own account: the tester's pause, the next reservation and the call of the step reserved before it are refused, and the fake records no send", async () => {
  const a = await sender();
  const step = await a.step("invite");
  const owner = as("Member", await ownerOf(a), a);
  const paused = await a.run(() => controls.pauseAccount(a.accountId, owner));
  assert.deepEqual([paused.killSwitch, paused.killSwitchSource], [true, "tester"]);
  assert.deepEqual(await next(a, "after-pause"), STOPPED);
  assert.deepEqual(await a.call("linkedin_send_invite", step.input()), STOPPED);
  assert.deepEqual(sends(), []);
});

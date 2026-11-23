// The end-to-end test of alpha-p1-040: the package used as a host uses it. Two fixture modules'
// permissions.ts are imported at start, as the host's generated module list does, and can() decides
// for an Owner, a signed-in non-member and a service principal the way a request guard asks it; a
// third module claiming an action already registered fails the start with both file names. The role
// check (gamma-p6-010): each role against each shape of roles a third fixture module declares (Owner
// only, Owner and Admin, every role, none), the service principal, and the order of the answers. The
// owned-row check (gamma-p6-015): canWriteOwned for the row's owner, another Member, an Owner, an
// Admin, the service principal and a row without an owner.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppError,
  can,
  canWriteOwned,
  httpStatus,
  isAppError,
  type PermissionResource,
  type Principal,
  type Role,
  registeredErrors,
  registeredPermissions,
  servicePrincipal,
} from "../index.ts";
import { throwsCode } from "../testing/index.ts";
import { permissions as leads } from "./fixtures/permissions/leads/permissions.ts";
import { permissions as notes } from "./fixtures/permissions/notes/permissions.ts";
import { permissions as shapes } from "./fixtures/permissions/shapes/permissions.ts";

const fixture = (module: string) =>
  new URL(`./fixtures/permissions/${module}/permissions.ts`, import.meta.url).href;
const workspaceA = "wsp_01JAB3K5ZQ7W9R2M4T6V8X0Y1A";
const workspaceB = "wsp_01JAB3K5ZQ7W9R2M4T6V8X0Y1B";
const owner: Principal = {
  userId: "usr_01JAB3K5ZQ7W9R2M4T6V8X0Y1C",
  actorType: "human",
  authMethod: "session",
  membershipId: "mem_01JAB3K5ZQ7W9R2M4T6V8X0Y1D",
  workspaceId: workspaceA,
  role: "Owner",
  scopes: [],
};
const nonMember: Principal = {
  userId: "usr_01JAB3K5ZQ7W9R2M4T6V8X0Y1E",
  actorType: "human",
  authMethod: "session",
  scopes: [],
};
const admin: Principal = {
  ...owner,
  userId: "usr_01JAB3K5ZQ7W9R2M4T6V8X0Y1F",
  membershipId: "mem_01JAB3K5ZQ7W9R2M4T6V8X0Y1G",
  role: "Admin",
};
const member: Principal = {
  ...owner,
  userId: "usr_01JAB3K5ZQ7W9R2M4T6V8X0Y1H",
  membershipId: "mem_01JAB3K5ZQ7W9R2M4T6V8X0Y1J",
  role: "Member",
};
/** The four shapes, in this order: Owner only, Owner and Admin, every role, none. */
const SHAPES = [
  shapes["shapes.owner"],
  shapes["shapes.owner_admin"],
  shapes["shapes.every_role"],
  shapes["shapes.service_only"],
];
const answers = (principal: Principal, resource?: PermissionResource) =>
  SHAPES.map((action) => can(principal, action, resource));

/** The principal behind a proxy that records which of its fields can() reads, in order. */
function watched(principal: Principal): { principal: Principal; reads: string[] } {
  const reads: string[] = [];
  const proxy = new Proxy(principal, {
    get(target, field, receiver) {
      reads.push(String(field));
      return Reflect.get(target, field, receiver);
    },
  });
  return { principal: proxy, reads };
}

/** What the api host's permission guard does with a decision (alpha-p2-010): pass, or throw the code. */
function guard(principal: Principal, action: string, resource?: PermissionResource): void {
  const decision = can(principal, action, resource);
  if (decision !== "allow") throw new AppError(decision);
}

test("the host collects every module's permissions.ts at start into one policy table", () => {
  const table = registeredPermissions();
  assert.deepEqual([...table.keys()].filter((action) => /^(leads|notes)\./.test(action)).sort(), [
    "leads.read",
    "leads.write",
    "notes.read",
  ]);
  const entry = table.get("leads.write");
  assert.deepEqual(entry, { roles: ["Owner", "Admin"], source: fixture("leads") });
  assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.roles));
  assert.equal(table.get("notes.read")?.source, fixture("notes"));
  assert.equal(leads["leads.read"], "leads.read");
  assert.equal(notes["notes.read"], "notes.read");
});

test("can() allows an Owner a registered action, a non-member gets forbidden, an unregistered action unknown_action", () => {
  assert.equal(can(owner, leads["leads.read"]), "allow");
  assert.equal(can(owner, "leads.write", { workspaceId: workspaceA }), "allow");
  assert.equal(can(owner, notes["notes.read"]), "allow");
  assert.equal(can(nonMember, "leads.read"), "forbidden");
  assert.equal(can(nonMember, "leads.read", { workspaceId: workspaceA }), "forbidden");
  assert.equal(can(owner, "leads.read", { workspaceId: workspaceB }), "forbidden");
  assert.equal(can(owner, "leads.delete"), "unknown_action");
  assert.equal(can(nonMember, "leads.delete"), "unknown_action");
  assert.doesNotThrow(() => guard(owner, "leads.read", { workspaceId: workspaceA }));
  throwsCode(() => guard(nonMember, "leads.read", { workspaceId: workspaceA }), "forbidden");
  throwsCode(() => guard(owner, "leads.write", { workspaceId: workspaceB }), "forbidden");
  throwsCode(() => guard(owner, "leads.delete"), "unknown_action");
  assert.equal(httpStatus("forbidden"), 403);
  assert.equal(httpStatus("unknown_action"), 500);
  assert.ok(registeredErrors().has("forbidden") && registeredErrors().has("unknown_action"));
});

test("a service principal, the worker or the seeder, is internal code: any registered action, no unknown one, its own workspace when bound", () => {
  const worker = servicePrincipal("worker");
  assert.deepEqual(worker, {
    userId: "service:worker",
    actorType: "service",
    authMethod: "internal",
    scopes: [],
  });
  assert.ok(Object.isFrozen(worker) && Object.isFrozen(worker.scopes));
  assert.equal(can(worker, "leads.write"), "allow");
  assert.equal(can(worker, "leads.write", { workspaceId: workspaceB }), "allow");
  assert.equal(can(worker, "leads.delete"), "unknown_action");
  const bound: Principal = { ...worker, workspaceId: workspaceA };
  assert.equal(can(bound, "leads.read", { workspaceId: workspaceA }), "allow");
  assert.equal(can(bound, "leads.read", { workspaceId: workspaceB }), "forbidden");
  assert.equal(can({ ...worker, authMethod: "session" }, "leads.read"), "forbidden");
  assert.equal(can({ ...worker, actorType: "human" }, "leads.read"), "forbidden");
  assert.throws(
    () => servicePrincipal("Worker"),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "invalid_service_name");
      assert.deepEqual(error.details, { service: "Worker" });
      return true;
    },
  );
  throwsCode(() => servicePrincipal(""), "invalid_service_name");
});

test("two modules registering the same action fail at start with both file names", async () => {
  await assert.rejects(
    () => import("./fixtures/permissions/duplicate/permissions.ts"),
    (error: unknown) => {
      assert.ok(isAppError(error), `expected an AppError, got ${String(error)}`);
      assert.equal(error.code, "duplicate_permission_action");
      assert.deepEqual(error.details, {
        action: "leads.read",
        sources: [fixture("leads"), fixture("duplicate")],
      });
      return true;
    },
  );
  assert.deepEqual(registeredPermissions().get("leads.read")?.roles, ["Owner", "Admin", "Member"]);
});

test("the role last: a Member is refused an action of Owner only or of Owner and Admin and allowed one of every role, an Admin the actions listing Admin, an Owner all three; an action with no roles refuses every human and allows the service", () => {
  const worker = servicePrincipal("worker");
  for (const resource of [undefined, { workspaceId: workspaceA }]) {
    assert.deepEqual(answers(owner, resource), ["allow", "allow", "allow", "forbidden"]);
    assert.deepEqual(answers(admin, resource), ["forbidden", "allow", "allow", "forbidden"]);
    assert.deepEqual(answers(member, resource), ["forbidden", "forbidden", "allow", "forbidden"]);
    assert.deepEqual(answers(worker, resource), ["allow", "allow", "allow", "allow"]);
  }
  const here = { workspaceId: workspaceA };
  assert.equal(can(member, leads["leads.write"], here), "forbidden");
  assert.equal(can(member, leads["leads.read"], here), "allow");
  assert.equal(can(member, notes["notes.read"], here), "allow");
  throwsCode(() => guard(member, shapes["shapes.owner_admin"], here), "forbidden");
  throwsCode(() => guard(owner, shapes["shapes.service_only"], here), "forbidden");
  assert.doesNotThrow(() => guard(worker, shapes["shapes.service_only"], here));
  // A role off the three, a typo or a cast, is no role: refused whatever the action lists.
  for (const role of ["owner", "Superuser", ""]) {
    const cast = { ...owner, role: role as Role };
    assert.deepEqual(answers(cast, here), ["forbidden", "forbidden", "forbidden", "forbidden"]);
  }
});

test("each role is allowed exactly the registered actions whose roles list it, in its workspace", () => {
  const byRole: Record<Role, Principal> = { Owner: owner, Admin: admin, Member: member };
  const table = registeredPermissions();
  assert.ok(table.size >= 7, "the three fixture modules' actions are registered");
  for (const [role, principal] of Object.entries(byRole) as [Role, Principal][]) {
    for (const [action, { roles }] of table) {
      const expected = roles.includes(role) ? "allow" : "forbidden";
      assert.equal(
        can(principal, action, { workspaceId: workspaceA }),
        expected,
        `${role} ${action}`,
      );
    }
  }
});

test("the earlier answers keep their order: unknown_action whoever asks, another workspace forbidden before any role is read, a human without membership, workspace or role forbidden", () => {
  const worker = servicePrincipal("worker");
  for (const who of [owner, admin, member, nonMember, worker]) {
    const { principal, reads } = watched(who);
    assert.equal(can(principal, "shapes.delete", { workspaceId: workspaceB }), "unknown_action");
    assert.deepEqual(reads, [], "nothing of the principal is read for an unknown action");
  }
  for (const who of [owner, admin, member, { ...worker, workspaceId: workspaceA }]) {
    for (const action of SHAPES) {
      const { principal, reads } = watched(who);
      assert.equal(can(principal, action, { workspaceId: workspaceB }), "forbidden");
      assert.ok(!reads.includes("role"), `${action}: the role was read: ${reads.join(", ")}`);
    }
  }
  for (const missing of ["membershipId", "workspaceId", "role"] as const) {
    const { principal, reads } = watched({ ...owner, [missing]: undefined });
    assert.equal(
      can(principal, shapes["shapes.every_role"], { workspaceId: workspaceA }),
      "forbidden",
    );
    assert.equal(can(principal, shapes["shapes.every_role"]), "forbidden", missing);
    assert.ok(reads.includes(missing), `${missing} was not read`);
  }
  // The role is read last, once the membership is known: a Member's refusal reads it.
  const { principal, reads } = watched(member);
  assert.equal(can(principal, shapes["shapes.owner"], { workspaceId: workspaceA }), "forbidden");
  assert.equal(reads.at(-1), "role");
});

test("canWriteOwned: the row's owner, a member here, and whoever can() allows the manage action write it; another Member is forbidden, and a row without an owner is the manage action's only", () => {
  const worker = servicePrincipal("worker");
  const manageAction = shapes["shapes.owner_admin"];
  const mine = { ownerUserId: member.userId, manageAction };
  const theirs = { ownerUserId: "usr_01JAB3K5ZQ7W9R2M4T6V8X0Y1K", manageAction };
  assert.equal(canWriteOwned(member, mine), "allow");
  assert.equal(canWriteOwned(member, theirs), "forbidden");
  for (const who of [owner, admin, worker]) {
    assert.equal(canWriteOwned(who, mine), "allow");
    assert.equal(canWriteOwned(who, theirs), "allow");
  }
  for (const ownerUserId of [null, ""]) {
    assert.equal(canWriteOwned(member, { ownerUserId, manageAction }), "forbidden");
    assert.equal(canWriteOwned(owner, { ownerUserId, manageAction }), "allow");
    assert.equal(canWriteOwned(worker, { ownerUserId, manageAction }), "allow");
  }
  // The owner's user id without a membership here owns nothing: the guard refuses it first anyway.
  for (const missing of ["membershipId", "workspaceId", "role"] as const) {
    assert.equal(canWriteOwned({ ...member, [missing]: undefined }, mine), "forbidden", missing);
  }
  const own = { ownerUserId: nonMember.userId, manageAction };
  assert.equal(canWriteOwned(nonMember, own), "forbidden");
  // An Owner-only manage action leaves an Admin to the owner match, as it does a Member.
  const ownerOnly = { ...theirs, manageAction: shapes["shapes.owner"] };
  assert.equal(canWriteOwned(admin, ownerOnly), "forbidden");
  assert.equal(canWriteOwned(admin, { ...ownerOnly, ownerUserId: admin.userId }), "allow");
  // An unregistered manage action is a bug in the caller: unknown_action, the owner included.
  for (const who of [owner, member, worker]) {
    assert.equal(canWriteOwned(who, { ...mine, manageAction: "shapes.delete" }), "unknown_action");
  }
  // What a module does with the answer: throw the code before it writes.
  const write = (principal: Principal) => {
    const decision = canWriteOwned(principal, theirs);
    if (decision !== "allow") throw new AppError(decision);
  };
  throwsCode(() => write(member), "forbidden");
  assert.doesNotThrow(() => write(owner));
});

// The end-to-end test of alpha-p1-040: the package used as a host uses it. Two fixture modules'
// permissions.ts are imported at start, as the host's generated module list does, and can() decides
// for an Owner, a signed-in non-member and a service principal the way a request guard asks it; a
// third module claiming an action already registered fails the start with both file names.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppError,
  can,
  httpStatus,
  isAppError,
  type PermissionResource,
  type Principal,
  registeredErrors,
  registeredPermissions,
  servicePrincipal,
} from "../index.ts";
import { throwsCode } from "../testing/index.ts";
import { permissions as leads } from "./fixtures/permissions/leads/permissions.ts";
import { permissions as notes } from "./fixtures/permissions/notes/permissions.ts";

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

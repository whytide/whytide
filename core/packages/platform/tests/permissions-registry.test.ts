// Unit tests of the permission registry (alpha-p1-040): an action is `<module>.<verb>` in lowercase,
// declared once; a second registration names both sources, in one list or across two; the roles and
// the source are checked at run time, so a malformed definition fails at start with a code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppError } from "../errors/index.ts";
import { definePermissions, registeredPermissions } from "../permissions/index.ts";
import type { Role } from "../principal/index.ts";
import { throwsCode } from "../testing/index.ts";

const first = "core/modules/fixture/permissions.ts";
const second = "core/modules/other/permissions.ts";

test("an action is declared once; the second registration fails naming both sources", () => {
  const permissions = definePermissions(
    [{ action: "fixture.read", roles: ["Owner", "Admin", "Member"] }],
    first,
  );
  assert.deepEqual(permissions, { "fixture.read": "fixture.read" });
  assert.ok(Object.isFrozen(permissions));
  assert.throws(
    () => definePermissions([{ action: "fixture.read", roles: ["Owner"] }], second),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "duplicate_permission_action");
      assert.deepEqual(error.details, { action: "fixture.read", sources: [first, second] });
      return true;
    },
  );
  throwsCode(
    () =>
      definePermissions(
        [
          { action: "fixture.write", roles: ["Owner"] },
          { action: "fixture.write", roles: ["Owner", "Admin"] },
        ],
        first,
      ),
    "duplicate_permission_action",
  );
  assert.deepEqual(registeredPermissions().get("fixture.read"), {
    roles: ["Owner", "Admin", "Member"],
    source: first,
  });
  assert.deepEqual(registeredPermissions().get("fixture.write")?.roles, ["Owner"]);
});

test("an action is <module>.<verb>: lowercase segments joined by dots, two or more", () => {
  const malformed = [
    "read",
    "Leads.read",
    "leads.Read",
    "leads read",
    "leads.",
    ".read",
    "leads..read",
    "leads-x.read",
    "leads.read ",
    "",
  ];
  for (const action of malformed) {
    throwsCode(
      () => definePermissions([{ action, roles: ["Owner"] }], first),
      "invalid_permission_action",
    );
  }
  const named = definePermissions(
    [
      { action: "company_knowledge.read", roles: ["Owner"] },
      { action: "leads.notes.write", roles: ["Owner"] },
    ],
    first,
  );
  assert.deepEqual(Object.keys(named), ["company_knowledge.read", "leads.notes.write"]);
});

test("roles are an array of the three roles, the empty list allowed; the source is a non-empty string", () => {
  const withRoles = (roles: unknown) => [
    { action: "fixture.shape", roles: roles as readonly Role[] },
  ];
  for (const roles of ["Owner", undefined, null, ["Owner", "owner"], [1], {}]) {
    assert.throws(
      () => definePermissions(withRoles(roles), first),
      (error: unknown) => {
        assert.ok(isAppError(error) && error.code === "invalid_permission_definition");
        assert.deepEqual(error.details, { action: "fixture.shape", source: first, field: "roles" });
        return true;
      },
    );
  }
  for (const source of [undefined, "", 42]) {
    assert.throws(
      () => definePermissions(withRoles(["Owner"]), source as unknown as string),
      (error: unknown) => {
        assert.ok(isAppError(error) && error.code === "invalid_permission_definition");
        assert.deepEqual(error.details, { field: "source" });
        return true;
      },
    );
  }
  assert.equal(registeredPermissions().has("fixture.shape"), false);
  assert.deepEqual(definePermissions([{ action: "fixture.service_only", roles: [] }], first), {
    "fixture.service_only": "fixture.service_only",
  });
  assert.deepEqual(registeredPermissions().get("fixture.service_only")?.roles, []);
});

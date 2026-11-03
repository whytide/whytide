// test:tenancy for memberships (docs/rules/security.md §3; core/packages/db README "Register a tenant
// table in the isolation test"): one user is a member of workspaces A and B, and the user's
// memberships read in a run of one workspace, scoped by the tenant client alone, are that
// workspace's only. Then the four tables as `app` reaches them, through createTwoWorkspaces.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, isolationTest, withTestDb } from "@whytide/db/testing";
import { parseId, servicePrincipal } from "@whytide/platform";
import type { User } from "../domain/commands.ts";
import {
  createMembership,
  createOrganizationWithWorkspace,
  createTwoWorkspaces,
  createUser,
} from "../testing/index.ts";

const db = withTestDb();

let member: User | undefined;
isolationTest("memberships", {
  async createRow(workspaceId) {
    await createOrganizationWithWorkspace({ workspaceId });
    member ??= await createUser();
    return createMembership({ userId: member.id, workspaceId });
  },
  readAs: (workspaceId) =>
    withTenant(
      { workspaceId, principal: servicePrincipal("tenancy_test") },
      (tx) => tx.membership.findMany({ where: { userId: member?.id } }),
      { client: asRole("app") },
    ),
});

test("createTwoWorkspaces: two organizations, a workspace and an Owner each, in under 50 ms; app reads and writes the four tables", async () => {
  const app = asRole("app");
  // A first call opens the connection and prepares Prisma's queries, once per process.
  await createTwoWorkspaces();
  await db.truncate();
  const started = performance.now();
  const [a, b] = await createTwoWorkspaces();
  const took = performance.now() - started;
  assert.ok(took < 50, `createTwoWorkspaces took ${took.toFixed(1)} ms`);

  const rows = {
    usr: await app.user.findMany(),
    org: await app.organization.findMany(),
    wsp: await app.workspace.findMany(),
    mem: await app.membership.findMany(),
  };
  for (const [prefix, list] of Object.entries(rows)) {
    assert.equal(list.length, 2, prefix);
    for (const row of list) parseId(row.id, prefix);
  }
  for (const tenant of [a, b]) {
    const { user, organization, workspace, membership } = tenant;
    assert.equal(workspace.organizationId, organization.id);
    assert.deepEqual(
      [membership.userId, membership.workspaceId, membership.role],
      [user.id, workspace.id, "Owner"],
    );
  }
  assert.notEqual(a.organization.id, b.organization.id);
  const updated = await app.user.update({ where: { id: a.user.id }, data: { locale: "en-GB" } });
  assert.equal(updated.locale, "en-GB");
});

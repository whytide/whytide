// sharingGroupOf (gamma-rf-010; README.md "Public interface"), on the worktree's database in this
// file's schema, in the caller's tenant run as contacts calls it: the run's workspace's organization
// answers, so two workspaces of one organization share one group and another organization's
// workspace never does; a workspace tenancy does not have answers null; and the read goes through
// the tenant client.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, assertScoped, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { createWorkspace, sharingGroupOf } from "../domain/commands.ts";
import { createTwoWorkspaces, useTenancyClient } from "../testing/index.ts";

withTestDb();
const principal = servicePrincipal("tenancy_test");
const groupIn = (workspaceId: string) =>
  withTenant({ workspaceId, principal }, () => sharingGroupOf(), { client: asRole("app") });

test("the run's workspace's organization answers, and another organization's never does", async () => {
  const [a, b] = await createTwoWorkspaces();
  assert.equal(await groupIn(a.workspace.id), a.organization.id);
  assert.equal(await groupIn(b.workspace.id), b.organization.id);
  assert.notEqual(a.organization.id, b.organization.id);
});

test("two workspaces of one organization share its group; an unknown workspace answers null", async () => {
  useTenancyClient(asRole("app"));
  const [a] = await createTwoWorkspaces();
  const organizationId = a.organization.id;
  const second = await createWorkspace({
    organizationId,
    name: "Second",
    slug: "second",
    ownerUserId: a.user.id,
  });
  assert.equal(await groupIn(a.workspace.id), organizationId);
  assert.equal(await groupIn(second.workspace.id), organizationId);
  assert.equal(await groupIn("wsp_not_in_tenancy"), null);
  await assertScoped(() => sharingGroupOf());
});

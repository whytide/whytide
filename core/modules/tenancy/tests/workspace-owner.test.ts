// workspaceOwner (gamma-p3-030; README.md "Public interface"), on the worktree's database in this
// file's schema, in the caller's tenant run as campaigns calls it: the user of the workspace's oldest
// Owner membership answers; an Admin or a Member never does, nor another workspace's Owner; a
// missing id is tenancy_input_invalid; and the read goes through the tenant client.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, assertScoped, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { workspaceOwner } from "../domain/commands.ts";
import {
  createMembership,
  createOrganizationWithWorkspace,
  createTwoWorkspaces,
  createUser,
} from "../testing/index.ts";

withTestDb();
const principal = servicePrincipal("tenancy_test");
const ownerIn = (runIn: string, workspaceId = runIn) =>
  withTenant({ workspaceId: runIn, principal }, () => workspaceOwner(workspaceId), {
    client: asRole("app"),
  });

test("the user of the oldest Owner membership answers; an Admin or a Member never does", async () => {
  const { workspace } = await createOrganizationWithWorkspace();
  const member = async (role: "Owner" | "Admin" | "Member") => {
    const user = await createUser();
    await createMembership({ userId: user.id, workspaceId: workspace.id, role });
    return user.id;
  };
  await member("Admin");
  await member("Member");
  assert.equal(await ownerIn(workspace.id), null, "no Owner yet");
  const oldest = await member("Owner");
  await member("Owner");
  await member("Admin");
  assert.equal(await ownerIn(workspace.id), oldest);
});

test("another workspace's Owner never answers, and a missing id is tenancy_input_invalid", async () => {
  const [a, b] = await createTwoWorkspaces();
  assert.equal(await ownerIn(a.workspace.id), a.user.id);
  assert.equal(await ownerIn(b.workspace.id), b.user.id);
  assert.equal(await ownerIn(a.workspace.id, b.workspace.id), null, "a run sees its own workspace");
  await assert.rejects(ownerIn(a.workspace.id, ""), { code: "tenancy_input_invalid" });
  await assertScoped(() => workspaceOwner(a.workspace.id));
});

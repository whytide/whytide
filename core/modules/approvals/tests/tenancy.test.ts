// test:tenancy for approval_items (docs/rules/security.md §3; core/packages/db README "Register a
// tenant table in the isolation test"): an item written in one workspace is not in the queue read
// in a run of another; every command and query goes through the tenant client; erasePerson deletes
// a person's items and no one else's, another workspace's included.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { erasePerson } from "../domain/erase.ts";
import { cancelItems } from "../domain/items/cancel.ts";
import { approve, skip } from "../domain/items/decide.ts";
import { openItem } from "../domain/items/open.ts";
import { approvedContent, decisionDays, decisionsFor, editStats } from "../domain/items/queries.ts";
import { readQueue } from "../domain/items/queue.ts";
import { noteItemWait } from "../domain/items/wait.ts";
import { createApprovalItem } from "../testing/index.ts";

withTestDb();
const client = asRole("app");
const principal = servicePrincipal("approvals_test");
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client });
let made = 0;
const item = (workspaceId: string, personId = "per_isolation") =>
  createApprovalItem(
    { workspaceId, personId, senderAccountId: "lac_isolation", stepExecutionId: `sx_${++made}` },
    client,
  );

isolationTest("approval_items", {
  createRow: async (workspaceId) => ({ id: await item(workspaceId) }),
  readAs: async (workspaceId) => (await inRun(workspaceId, () => readQueue(principal))).items,
});

test("erasePerson deletes the person's items, and no one else's; the commands and queries go through the tenant client", async () => {
  const workspaceId = "wsp_erasure";
  for (const personId of ["per_erased", "per_erased", "per_kept"])
    await item(workspaceId, personId);
  const theirs = await item("wsp_other", "per_erased");
  assert.deepEqual(await inRun(workspaceId, () => erasePerson("per_erased")), {
    approval_items: 2,
  });
  const left = await client.approvalItem.findMany({
    where: { workspaceId: { in: [workspaceId, "wsp_other"] } },
  });
  assert.deepEqual(left.map(({ id, personId }) => [id === theirs, personId]).sort(), [
    [false, "per_kept"],
    [true, "per_erased"],
  ]);
  await assert.rejects(
    inRun(workspaceId, () => erasePerson("")),
    { code: "person_not_found" },
  );

  const step = { stepExecutionId: "sx_none", personId: "per_none", senderAccountId: "lac_none" };
  const open = {
    ...step,
    stepKey: "message_1",
    senderUserId: "usr_none",
    scheduledFor: new Date(),
  };
  const since = { since: new Date() };
  await assertScoped(() => openItem({ ...open, actionType: "message" }));
  await assertScoped(() => approve("apv_none", {}, principal));
  await assertScoped(() => skip("apv_none", principal));
  await assertScoped(() => cancelItems(["sx_none"]));
  await assertScoped(() => noteItemWait("sx_none", null));
  await assertScoped(() => approvedContent("sx_none"));
  await assertScoped(() => decisionsFor(["sx_none"]));
  await assertScoped(() => editStats(since));
  await assertScoped(() => decisionDays(since));
  await assertScoped(() => readQueue(principal));
  await assertScoped(() => erasePerson("per_none"));
});

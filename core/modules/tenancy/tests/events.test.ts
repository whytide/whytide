// tenancy.organization_created (alpha-p3-050): bootstrapOrganization writes it to the outbox in its own
// transaction, with the two ids only, and a refused bootstrap writes none. Its delivery to credits is
// core/modules/credits/tests/seed.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { bootstrapOrganization, upsertUser } from "../domain/commands.ts";
import { useTenancyClient } from "../testing/index.ts";

withTestDb();
useTenancyClient(asRole("app"));

test("bootstrapOrganization publishes tenancy.organization_created in its transaction; a refused one publishes nothing", async () => {
  const owner = await upsertUser({ email: "owner@example.com" });
  const input = { name: "Acme", workspaceSlug: "acme", ownerUserId: owner.id };
  const { organization, workspace } = await bootstrapOrganization(input);
  await assert.rejects(bootstrapOrganization({ ...input, name: "Again" }));
  // xmin is the id of the transaction that wrote a row: the workspace's and the event's are one.
  const rows = await asRole("app").$queryRaw<unknown[]>`
    SELECT o.event_name, o.workspace_id, o.payload, o.xmin = w.xmin AS same_transaction
    FROM outbox o JOIN workspaces w ON w.id = o.workspace_id`;
  const payload = { organizationId: organization.id, workspaceId: workspace.id };
  const event = { event_name: "tenancy.organization_created", workspace_id: workspace.id };
  assert.deepEqual(rows, [{ ...event, payload, same_transaction: true }]);
});

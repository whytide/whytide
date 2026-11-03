// test:tenancy for credit_usage (docs/rules/security.md §3; core/packages/db README "Register a tenant
// table in the isolation test"), with the usage list's query and the cost counter's reads checked by
// assertScoped; then the wallet, one per organization: a workspace of organization B reads B's balance
// through readBalance, never A's.
import assert from "node:assert/strict";
import test from "node:test";
import { type TenantClient, tenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, newId, servicePrincipal } from "@whytide/platform";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { readBalance } from "../domain/balance.ts";
import { leadCost } from "../domain/costs/lead.ts";
import { weeklyCosts } from "../domain/costs/weekly.ts";
import { seed, seedOrganization } from "../domain/seed.ts";
import { useClient } from "../domain/store.ts";
import { listUsage } from "../domain/usage.ts";
import { ids } from "../ids.ts";

withTestDb();
useTenancyClient(asRole("app"));
useClient(asRole("app"));
const principal = servicePrincipal("credits_test");
const inWorkspace = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });

/** A reservation in the workspace, as alpha-p3-060's reserve will write one. */
const reserve = (workspaceId: string, organizationId: string, credits: number) =>
  inWorkspace(workspaceId, (tx) =>
    tx.creditUsage.create({
      data: {
        id: newId(ids.credit_usage),
        organizationId,
        workspaceId,
        action: "credits_test.action",
        quantity: 1,
        credits,
        idempotencyKey: newId(ids.credit_usage),
        leaseExpiresAt: new Date(Date.now() + 15 * 60_000),
        subjectRef: "lead_test",
      },
    }),
  );

isolationTest("credit_usage", {
  createRow: (workspaceId) => reserve(workspaceId, `org_of_${workspaceId}`, 1),
  readAs: (workspaceId) => inWorkspace(workspaceId, (tx) => tx.creditUsage.findMany()),
});

test("the usage list runs on the tenant client", () =>
  assertScoped(() => listUsage(tenantClient, { limit: 10 })));

test("the cost counter's reads, the week's and a lead's, run on the tenant client", async () => {
  await assertScoped(() => weeklyCosts({ workspaceId: "wsp_assert", week: "2026-W43" }));
  await assertScoped(() => leadCost("per_none"));
});

test("a workspace of organization B reads B's balance, never A's", async () => {
  const log = createLogger({ destination: collectLogs().destination });
  await seed(asRole("billing_writer"), log, {
    CREDITS_MONTHLY_ALLOWANCE: 100,
    CREDITS_PLAN_CODE: "self_hosted",
  });
  const [a, b] = await createTwoWorkspaces();
  for (const { organization } of [a, b]) await seedOrganization(asRole("app"), organization.id);
  await reserve(a.workspace.id, a.organization.id, 30);

  const numbers = async (workspaceId: string) => {
    const balance = await readBalance(workspaceId);
    return balance && [balance.organizationId, balance.granted, balance.reserved];
  };
  assert.deepEqual(await numbers(a.workspace.id), [a.organization.id, "100", "30"]);
  assert.deepEqual(await numbers(b.workspace.id), [b.organization.id, "100", "0"]);
  assert.equal(await readBalance("wsp_missing"), null);
});

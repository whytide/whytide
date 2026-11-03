// test:tenancy for icps and criteria (docs/rules/security.md §3; core/packages/db README "Register a
// tenant table in the isolation test"): rows made by getIcp, read through the tenant client in a run
// of one workspace. Then readIcpForScoring, qualification's query, in the caller's run: the ICP and
// its six criteria in one call, another workspace refused, its database calls scoped.
import assert from "node:assert/strict";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { getIcp, readIcpForScoring } from "../domain/commands.ts";
import { DEFAULT_CRITERIA } from "../domain/lists.ts";

withTestDb();

const principal = servicePrincipal("icp_test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });

isolationTest("icps", {
  createRow: (workspaceId) => inRun(workspaceId, () => getIcp(workspaceId)),
  readAs: (workspaceId) => inRun(workspaceId, (tx) => tx.icp.findMany({})),
});

isolationTest("criteria", {
  createRow: (workspaceId) =>
    inRun(workspaceId, async (tx) => {
      await getIcp(workspaceId);
      return tx.criterion.findFirstOrThrow({ where: { key: "location" } });
    }),
  readAs: (workspaceId) => inRun(workspaceId, (tx) => tx.criterion.findMany({})),
});

test("readIcpForScoring: the ICP and its six criteria in one call, in the caller's run; another workspace is refused", async () => {
  const workspaceId = "wsp_scoring";
  const read = () => inRun(workspaceId, () => readIcpForScoring(workspaceId));
  const { icp, criteria } = await read();
  assert.deepEqual([icp.version, icp.titles, icp.countries], [1, [], []]);
  assert.deepEqual(criteria, DEFAULT_CRITERIA);
  assert.equal((await read()).icp.id, icp.id, "the second read finds the same ICP");
  await assert.rejects(
    inRun(workspaceId, () => readIcpForScoring("wsp_other")),
    (error: unknown) => isAppError(error) && error.code === "tenant_mismatch",
  );
  await assertScoped(() => readIcpForScoring("wsp_assert"));
});

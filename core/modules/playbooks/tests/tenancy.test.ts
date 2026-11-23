// test:tenancy for playbooks and playbook_sources (docs/rules/security.md §3; core/packages/db README
// "Register a tenant table in the isolation test"): rows made by the commands in a run of one
// workspace, read through the tenant client in a run of another. Then assertScoped on the readers and
// the commands: each goes through the run's tenant client, never a client of its own.
import { after, test } from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { ids as icpIds } from "@whytide/icp";
import { newId, servicePrincipal } from "@whytide/platform";
import {
  checkSources,
  createPlaybook,
  detachSource,
  getPlaybook,
  listPlaybooks,
  playbookOfSource,
  setSources,
  sourcesOf,
  updatePlaybook,
} from "../domain/playbooks.ts";
import { useSourceChecker } from "../testing/index.ts";

withTestDb();

const OWNER = "usr_owner";
const principal = servicePrincipal("playbooks_test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
after(
  useSourceChecker(async (sourceIds) =>
    sourceIds.map((sourceId) => ({
      sourceId,
      found: true,
      readingAccountId: "sac_tenancy",
      readingOwnerUserId: OWNER,
    })),
  ),
);

/** An agent made by createPlaybook on an audience of the workspace's (icp has no test factory). */
async function agentIn(workspaceId: string) {
  const icpId = newId(icpIds.icp);
  await asRole("app").icp.create({ data: { id: icpId, workspaceId, isDefault: false } });
  return inRun(workspaceId, () => createPlaybook({ name: "Agent", icpId, ownerUserId: OWNER }));
}

isolationTest("playbooks", {
  createRow: agentIn,
  readAs: (workspaceId) => inRun(workspaceId, () => listPlaybooks()),
});

isolationTest("playbook_sources", {
  createRow: async (workspaceId) => {
    const agent = await agentIn(workspaceId);
    await inRun(workspaceId, () => setSources(agent.id, ["src_tenancy"]));
    const where = { playbookId: agent.id };
    return inRun(workspaceId, (tx) => tx.playbookSource.findFirstOrThrow({ where }));
  },
  readAs: (workspaceId) => inRun(workspaceId, (tx) => tx.playbookSource.findMany({})),
});

test("assertScoped: the readers and the commands go through the run's tenant client", async () => {
  const input = { name: "Agent", icpId: "icp_assert", ownerUserId: OWNER };
  await assertScoped(() => getPlaybook("pbk_assert"));
  await assertScoped(() => listPlaybooks());
  await assertScoped(() => sourcesOf("pbk_assert"));
  await assertScoped(() => playbookOfSource("src_assert"));
  await assertScoped(() => detachSource("src_assert"));
  await assertScoped(() => createPlaybook(input));
  await assertScoped(() => updatePlaybook("pbk_assert", { status: "paused" }));
  await assertScoped(() => setSources("pbk_assert", ["src_assert"]));
  await assertScoped(() => checkSources("pbk_assert", ["src_assert"]));
});

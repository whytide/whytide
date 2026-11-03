// test:tenancy for import_jobs (docs/rules/security.md §3; core/packages/db README "Register a tenant
// table in the isolation test"): a job in workspaces A and B, written as the upload writes it, read
// with the list query in a run of one workspace, scoped by the tenant client alone.
import { withTenant } from "@whytide/db";
import { asRole, isolationTest, withTestDb } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { createImportJob, listImportJobs } from "../domain/jobs.ts";
import { RowCheck } from "../domain/rows.ts";
import { inRun } from "../domain/store.ts";
import { ids } from "../ids.ts";
import { useDiscoveryClient } from "../testing/index.ts";

withTestDb();
useDiscoveryClient(asRole("app"));

const tenant = (workspaceId: string) => ({
  workspaceId,
  principal: servicePrincipal("discovery_test"),
});

isolationTest("import_jobs", {
  createRow: (workspaceId) =>
    inRun(tenant(workspaceId), (tx) => {
      const id = newId(ids.import_job);
      const fileKey = `w/${workspaceId}/imports/${id}.csv`;
      const report = new RowCheck().report();
      const job = {
        id,
        workspaceId,
        fileKey,
        fileName: "people.csv",
        createdBy: "usr_test",
        report,
      };
      return createImportJob(tx, job);
    }),
  readAs: (workspaceId) =>
    withTenant(tenant(workspaceId), () => listImportJobs(), { client: asRole("app") }),
});

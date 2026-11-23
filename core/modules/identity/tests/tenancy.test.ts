// test:tenancy for invites (docs/rules/security.md §3; core/packages/db README "Register a tenant
// table in the isolation test"): one email invited to workspaces A and B, the invites read in a run
// of one workspace, scoped by the tenant client alone, are that workspace's only.
import { withTenant } from "@whytide/db";
import { asRole, isolationTest, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { createOrganizationWithWorkspace, useTenancyClient } from "@whytide/tenancy/testing";
import { createInvite } from "../domain/invites.ts";
import { useIdentityClient } from "../testing/index.ts";

withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));

const email = "isolated@example.test";
isolationTest("invites", {
  async createRow(workspaceId) {
    await createOrganizationWithWorkspace({ workspaceId });
    return createInvite({ workspaceId, email, role: "Member", invitedBy: null });
  },
  readAs: (workspaceId) =>
    withTenant(
      { workspaceId, principal: servicePrincipal("identity_test") },
      (tx) => tx.invite.findMany({ where: { email } }),
      { client: asRole("app") },
    ),
});

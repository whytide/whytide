// assertScoped(query), for a module's tests (alpha-p1-045): the query runs in a workspace's context
// without withTenant's transaction, where the tenant client refuses with no_tenant_context. One that
// reads the context and then a client of its own runs: not scoped, and the assertion fails. Any other
// error is the query's own and is rethrown: a command that opens its own withTenant, or a query
// through the global client, fails with nested_run, so check the query that runs inside the run. It
// proves the query's first database call only; the isolation harness proves the rows.
import assert from "node:assert/strict";
import { isAppError, servicePrincipal, withTenantContext } from "@whytide/platform";

export async function assertScoped(query: () => Promise<unknown>): Promise<void> {
  const context = { workspaceId: "wsp_assert", principal: servicePrincipal("assert_scoped") };
  await assert.rejects(
    async () => withTenantContext(context, query),
    (error: unknown) => {
      if (isAppError(error) && error.code === "no_tenant_context") return true;
      throw error;
    },
    "the query ran without withTenant's transaction: it does not go through the tenant client",
  );
}

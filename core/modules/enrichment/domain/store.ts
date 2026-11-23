// How enrichment reaches the database outside an activity's run (docs/security.md): one `app` client
// per process, made at first use, for two paths only. The tick's check of a workspace, a run in that
// workspace as the service principal `enrichment`; and the counters of source_usage, a global
// table, outside any run on the global client inside withoutTenant (domain/usage.ts). The other
// steps run in the caller's run: an activity's context.tenant, a request's tenant run.
import {
  createDbClient,
  globalClient,
  type PrismaClient,
  type TenantClient,
  withTenant,
} from "@whytide/db";
import { servicePrincipal, withoutTenant } from "@whytide/platform";

const principal = servicePrincipal("enrichment");
let own: PrismaClient | undefined;
let given: PrismaClient | undefined;

function client(): PrismaClient {
  return given ?? (own ??= createDbClient("app"));
}

/** For tests (testing/): the client to run on instead of the process's own, `asRole("app")`. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

/** A run in the workspace as the service principal `enrichment`. */
export function inWorkspace<T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) {
  return withTenant({ workspaceId, principal }, fn, { client: client() });
}

/** The global tables outside any run, on the global client: source_usage's counters. */
export function inGlobal<T>(fn: (db: TenantClient) => Promise<T>): Promise<T> {
  return withoutTenant("enrichment.usage", () => fn(globalClient(client())));
}

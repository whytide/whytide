// How email reaches its tables outside a request's run (docs/security.md): one `app` client per
// process, made at first use, for the callback's own runs, one per database step around the code
// exchange (whytide:own-runs). The other routes use the request's run (tenantClient), and the
// worker's activities theirs (context.tenant): never this.
import { createDbClient, type PrismaClient, type TenantClient, withTenant } from "@whytide/db";
import type { TenantContext } from "@whytide/platform";

let own: PrismaClient | undefined;
let given: PrismaClient | undefined;

export function client(): PrismaClient {
  return given ?? (own ??= createDbClient("app"));
}

/** For tests (testing/): the client to run on instead of the process's own, `asRole("app")`. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

/** Ends the process's own client, at the api's shutdown; a given one stays. */
export async function disconnectClient(): Promise<void> {
  const ending = own;
  own = undefined;
  await ending?.$disconnect();
}

/** One database step of the callback: a run in the request's workspace, as its principal. */
export function inRun<T>(tenant: TenantContext, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
  return withTenant(tenant, fn, { client: client() });
}

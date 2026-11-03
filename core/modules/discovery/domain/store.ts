// How discovery reaches import_jobs (docs/security.md): the GET routes and the run's claim through the
// request's run, the tenant client of the api host; the upload, which reads a stream outside any run
// (core/apps/api README "Request protection", whytide:own-runs), and the worker's activities of the
// import's run, through runs of their own, one per database step, on the module's own `app` client,
// made at first use.
import { createDbClient, type PrismaClient, type TenantClient, withTenant } from "@whytide/db";
import type { TenantContext } from "@whytide/platform";

let own: PrismaClient | undefined;
let given: PrismaClient | undefined;

function client(): PrismaClient {
  return given ?? (own ??= createDbClient("app"));
}

/** For tests (testing/): the client to run on instead of the process's own, `asRole("app")`. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

/** Ends the process's own client, at the api's shutdown (api/imports.controller.ts); a given one stays. */
export async function disconnectClient(): Promise<void> {
  const ending = own;
  own = undefined;
  await ending?.$disconnect();
}

/** One database step of the upload or the run: a run in the request's workspace, as its principal. */
export function inRun<T>(
  tenant: TenantContext,
  fn: (tx: TenantClient) => Promise<T>,
  options: { readonly timeout?: number } = {},
): Promise<T> {
  return withTenant(tenant, fn, { ...options, client: client() });
}

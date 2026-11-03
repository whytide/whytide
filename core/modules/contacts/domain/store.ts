// contacts' own runs (docs/security.md): every command runs in its caller's run, but the CSV export
// writes to a client that may read slowly, which no run may wait on (core/apps/api README "Request
// protection", whytide:own-runs): it reads each page in a run of its own, on the module's own `app`
// client, made at first use.
import { createDbClient, type PrismaClient, withTenant } from "@whytide/db";
import type { TenantContext } from "@whytide/platform";

let own: PrismaClient | undefined;
let given: PrismaClient | undefined;

/** For tests (testing/): the client to run on instead of the process's own, `asRole("app")`. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

/** Ends the process's own client, at the api's shutdown (api/exports.controller.ts). */
export async function disconnectClient(): Promise<void> {
  const ending = own;
  own = undefined;
  await ending?.$disconnect();
}

/** One database step: a run in the request's workspace, as its principal. */
export function inRun<T>(tenant: TenantContext, fn: () => Promise<T>): Promise<T> {
  return withTenant(tenant, fn, { client: given ?? (own ??= createDbClient("app")) });
}

// How linkedin reaches its table outside a request's run (docs/security.md): one `app` client per
// process, made at first use, for four paths only. The connect route's own runs, one per database
// step around the provider call (whytide:own-runs); the webhook's lookup of an account by its link or
// its hash across workspaces, on the client by name (core/packages/db README "Limits"), the one read
// across workspaces; a run in the account's workspace as the service principal `linkedin`; and the
// global tables outside any run, in a transaction on the global client inside withoutTenant: the
// platform's switches (domain/controls/, for the operator's command, cli/control.ts) and the daily
// job's deletes of the receipts (domain/retention/purge.ts). The other routes use the request's own
// run (tenantClient), and the worker's other activities theirs (context.tenant): never this.
import {
  createDbClient,
  globalClient,
  type PrismaClient,
  type TenantClient,
  withTenant,
} from "@whytide/db";
import { servicePrincipal, type TenantContext, withoutTenant } from "@whytide/platform";

const principal = servicePrincipal("linkedin");
let own: PrismaClient | undefined;
let given: PrismaClient | undefined;

export function client(): PrismaClient {
  return given ?? (own ??= createDbClient("app"));
}

/** For tests (testing/): the client to run on instead of the process's own, `asRole("app")`. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

/** Ends the process's own client, at the api's shutdown (api/accounts.controller.ts); a given one stays. */
export async function disconnectClient(): Promise<void> {
  const ending = own;
  own = undefined;
  await ending?.$disconnect();
}

/** One database step of the connect route: a run in the request's workspace, as its principal. */
export function inRun<T>(tenant: TenantContext, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
  return withTenant(tenant, fn, { client: client() });
}

/** A run in the workspace as the service principal `linkedin`. */
export function inWorkspace<T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) {
  return withTenant({ workspaceId, principal }, fn, { client: client() });
}

/**
 * The global tables outside any run, in one transaction on the global client: the platform's switch
 * and its event commit together, as a batch of the receipts' deletes does; `reason` is the log's
 * (withoutTenant). globalClient() is typed as a transaction's client, which has no
 * $transaction, but it is the `app` client extended with the global guard, and that guard checks
 * every query of its transactions, as withTenant's guard checks its runs (core/packages/db).
 */
export function inGlobal<T>(
  fn: (db: TenantClient) => Promise<T>,
  reason = "linkedin.controls",
): Promise<T> {
  const global = globalClient(client()) as unknown as Pick<PrismaClient, "$transaction">;
  return withoutTenant(reason, () => global.$transaction((tx) => fn(tx)));
}

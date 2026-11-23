// How credits reads its organization-level tables (docs/security.md): they are global models, read
// outside any run through withoutTenant("credits.<reason>") and the global client, or inside the
// caller's run through its own transaction (the credits client), for the organization the
// workspace belongs to, never one a caller names. One `app` client per process, made at first use
// and closed with the api. The event handler works in the run the worker opens, the seeder on a
// billing_writer client of its own and the worker's period pass in withoutTenant (seed.ts). The
// alerts' mail opens one run per workspace of the organization, as the service `credits`, for
// tenancy's members (alerts/mail.ts).
import {
  createDbClient,
  globalClient,
  type PrismaClient,
  type TenantClient,
  withTenant,
} from "@whytide/db";
import { servicePrincipal, withoutTenant } from "@whytide/platform";

let own: PrismaClient | undefined;
let given: PrismaClient | undefined;
const principal = servicePrincipal("credits");

const client = (): PrismaClient => given ?? (own ??= createDbClient("app"));

/** For tests: the client to run on instead of the process's own, `asRole("app")`. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

/** Ends the process's own client, at the api's shutdown (api/credits.controller.ts); a given one stays. */
export async function disconnectClient(): Promise<void> {
  const ending = own;
  own = undefined;
  await ending?.$disconnect();
}

/**
 * The global tables, outside any run; withoutTenant logs the reason, `credits.<reason>`. `fn` also
 * gets the `app` client itself, for credits_seed_self_hosted: the global client refuses raw SQL.
 */
export function inGlobal<T>(
  reason: string,
  fn: (db: TenantClient, app: PrismaClient) => Promise<T>,
): Promise<T> {
  const app = client();
  return withoutTenant(`credits.${reason}`, () => fn(globalClient(app), app));
}

/** One tenant run of the workspace as the service `credits`, outside any other run. */
export function inWorkspace<T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) {
  return withTenant({ workspaceId, principal }, fn, { client: client() });
}

/**
 * The organization of the workspace, read in the caller's run, or null. tenancy's findWorkspace goes
 * through withoutTenant, which a run refuses (`nested_run`), so the client reads the workspace's
 * `organization_id` in the run's own transaction: the one read of a tenancy table here, until tenancy
 * has a query for a run (README "Decided here").
 */
export async function organizationOf(
  tx: TenantClient,
  workspaceId: string,
): Promise<string | null> {
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  return workspace?.organizationId ?? null;
}

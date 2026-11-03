// How tenancy reaches its tables (docs/security.md): one `app` client per process, made at first use,
// on three paths and no other. A run in one workspace for memberships; the global tables (users,
// organizations, workspaces) outside any run, through withoutTenant("tenancy"); and the one read
// across workspaces, a user's own memberships, on the client by name (core/packages/db README
// "Limits"). The commands open their own run, so none of them runs inside another one.
import {
  createDbClient,
  globalClient,
  type PrismaClient,
  type TenantClient,
  withTenant,
} from "@whytide/db";
import { servicePrincipal, withoutTenant } from "@whytide/platform";
import type { Membership } from "./commands.ts";
import { requireId } from "./rules.ts";

const principal = servicePrincipal("tenancy");
let own: PrismaClient | undefined;
let given: PrismaClient | undefined;

function client(): PrismaClient {
  return given ?? (own ??= createDbClient("app"));
}

/** For tests (testing/): the client to run on instead of the process's own, `asRole("app")`. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

/** Ends the process's own client, at the api's shutdown (api/me.controller.ts); a given one stays. */
export async function disconnectClient(): Promise<void> {
  const ending = own;
  own = undefined;
  await ending?.$disconnect();
}

/** A run in the workspace as the service principal `tenancy`: its client scopes every membership. */
export function inWorkspace<T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) {
  return withTenant({ workspaceId, principal }, fn, { client: client() });
}

/** The global tables, outside any run; withoutTenant logs the reason, `tenancy`. */
export function inGlobal<T>(fn: (db: TenantClient) => Promise<T>): Promise<T> {
  return withoutTenant("tenancy", () => fn(globalClient(client())));
}

/**
 * The one read of a tenant table across workspaces: the user's own memberships, oldest first. It
 * never lists a workspace's members; listMemberships and resolveMembership are built on it.
 */
export async function membershipsOfUser(userId: string): Promise<Membership[]> {
  // Prisma drops an undefined value from a where: unchecked, that would be every membership.
  const id = requireId("userId", userId);
  return client().membership.findMany({
    where: { userId: id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

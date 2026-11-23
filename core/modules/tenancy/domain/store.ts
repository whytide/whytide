// How tenancy reaches its tables (docs/security.md): one `app` client per process, made at first use,
// on four paths and no other. A run in one workspace for memberships; the global tables (users,
// organizations, workspaces) outside any run, through withoutTenant("tenancy"); the one read
// across workspaces, a user's own memberships, on the client by name (core/packages/db README
// "Limits"); and the caller's own run: the workspace's oldest Owner (gamma-p3-030), the members,
// their role changes and removals (gamma-p6-030), and the run's sharing group (gamma-rf-010). The
// other commands open their own run, so none of them runs inside another one. Every read of
// memberships skips a removed one.
import {
  createDbClient,
  globalClient,
  outboxWriter,
  type PrismaClient,
  type TenantClient,
  tenantClient,
  withTenant,
} from "@whytide/db";
import { currentTenant, type Role, servicePrincipal, withoutTenant } from "@whytide/platform";
import type { Membership, User } from "./commands.ts";
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
 * The one read of a tenant table across workspaces: the user's own active memberships, oldest
 * first. It never lists a workspace's members; listMemberships and resolveMembership are built on it.
 */
export async function membershipsOfUser(userId: string): Promise<Membership[]> {
  // Prisma drops an undefined value from a where: unchecked, that would be every membership.
  const id = requireId("userId", userId);
  return client().membership.findMany({
    where: { userId: id, removedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * The workspace's oldest active Owner membership, or null, in the caller's tenant run for the
 * workspace: its client sees that workspace's rows only, so another workspace's id finds none.
 */
export function oldestOwner(workspaceId: string): Promise<Membership | null> {
  return tenantClient.membership.findFirst({
    where: { workspaceId, role: "Owner", removedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * The organization of the run's workspace, or null for a workspace tenancy does not have, in the
 * caller's run: the workspace is the run's own (currentTenant), never one a caller names.
 */
export async function runOrganization(): Promise<string | null> {
  const workspace = await tenantClient.workspace.findUnique({
    where: { id: currentTenant().workspaceId },
    select: { organizationId: true },
  });
  return workspace?.organizationId ?? null;
}

/** The run's workspace's active memberships, oldest first, in the caller's run. */
export function activeMemberships(): Promise<Membership[]> {
  return tenantClient.membership.findMany({
    where: { removedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** The users with the ids, global rows the caller's run reads through its own client. */
export function usersOf(userIds: readonly string[]): Promise<User[]> {
  return tenantClient.user.findMany({ where: { id: { in: [...userIds] } } });
}

/** The user's active membership of the run's workspace, or null, in the caller's run. */
export function activeMembershipOf(userId: string): Promise<Membership | null> {
  return tenantClient.membership.findFirst({ where: { userId, removedAt: null } });
}

/**
 * The membership with the id and every active Owner membership of the run's workspace, locked to
 * the run's end (SELECT … FOR UPDATE) in id order: two changes at once lock in one order, so the
 * second waits for the first's commit and then reads the rows as it left them, an Owner it demoted
 * or removed no longer matching. The raw query names the run's workspace itself.
 */
export function lockMembershipAndOwners(membershipId: string): Promise<Membership[]> {
  const { workspaceId } = currentTenant();
  return tenantClient.$queryRaw<Membership[]>`
    SELECT id, workspace_id AS "workspaceId", user_id AS "userId", role, created_at AS "createdAt",
      removed_at AS "removedAt", removed_by AS "removedBy"
    FROM memberships
    WHERE workspace_id = ${workspaceId}
      AND (id = ${membershipId} OR (role = 'Owner' AND removed_at IS NULL))
    ORDER BY id
    FOR UPDATE`;
}

/** The membership with the role, or removed by the user, in the caller's run. */
export function updateMembership(
  id: string,
  data: { role: Role } | { removedAt: Date; removedBy: string },
): Promise<Membership> {
  return tenantClient.membership.update({ where: { id }, data });
}

/** The outbox of the caller's run, for publish(): the event commits or rolls back with the run. */
export function runOutbox() {
  return outboxWriter(tenantClient, currentTenant().workspaceId);
}

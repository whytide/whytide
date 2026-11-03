// How identity reaches its table (docs/security.md): one `app` client per process, made at first use,
// on two paths and no other. invites in a run of one workspace, as the service principal `identity`;
// and the one read of invites across workspaces, an email's pending invites, on the client by name
// (core/packages/db README "Limits"). The commands open their own run, so none runs inside another.
import { createDbClient, type PrismaClient, type TenantClient, withTenant } from "@whytide/db";
import { servicePrincipal } from "@whytide/platform";
import type { Invite } from "./invites.ts";
import { requireEmail } from "./rules.ts";

const principal = servicePrincipal("identity");
let own: PrismaClient | undefined;
let given: PrismaClient | undefined;

function client(): PrismaClient {
  return given ?? (own ??= createDbClient("app"));
}

/** For tests (testing/): the client to run on instead of the process's own, `asRole("app")`. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

/** A run in the workspace as the service principal `identity`: its client scopes every invite. */
export function inWorkspace<T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) {
  return withTenant({ workspaceId, principal }, fn, { client: client() });
}

/**
 * The one read of invites across workspaces: the email's invites not accepted yet, oldest first, for
 * allowSignIn and the first sign-in. It never lists a workspace's invites. The email is checked
 * first: Prisma drops an undefined value from a where, which would be every pending invite.
 */
export function pendingInvitesOf(email: string): Promise<Invite[]> {
  return client().invite.findMany({
    where: { email: requireEmail(email), acceptedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

// How identity reaches its table (docs/security.md): one `app` client per process, made at first use,
// on three paths and no other. invites in a run of one workspace, as the service principal
// `identity`; the one read of invites across workspaces, an email's open invites, on the client by
// name (core/packages/db README "Limits"); and the caller's own run, the request's, where the
// Invites screen's list and revoke read and write the run's workspace's invites (gamma-p6-020).
// The commands open their own run, so none runs inside another.
import {
  createDbClient,
  type PrismaClient,
  type TenantClient,
  tenantClient,
  withTenant,
} from "@whytide/db";
import { servicePrincipal } from "@whytide/platform";
import { now } from "./clock.ts";
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

/** Ends the process's own client, at the api's shutdown (api/invitations.controller.ts); a given one stays. */
export async function disconnectClient(): Promise<void> {
  const ending = own;
  own = undefined;
  await ending?.$disconnect();
}

/** A run in the workspace as the service principal `identity`: its client scopes every invite. */
export function inWorkspace<T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) {
  return withTenant({ workspaceId, principal }, fn, { client: client() });
}

/**
 * The one read of invites across workspaces: the email's open invites, oldest first, for
 * allowSignIn, the first sign-in, GET /v1/invitations and the accept. Open is filtered here, at the
 * module's time: not accepted, not revoked, before its expiry. It never lists a workspace's invites.
 * The email is checked first: Prisma drops an undefined value from a where, which would be every
 * open invite.
 */
export function pendingInvitesOf(email: string): Promise<Invite[]> {
  return client().invite.findMany({
    where: {
      email: requireEmail(email),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: now() },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** The run's workspace's invites not accepted, the latest invited or renewed first, in the caller's run. */
export function invitesNotAccepted(): Promise<Invite[]> {
  return tenantClient.invite.findMany({
    where: { acceptedAt: null },
    orderBy: [{ expiresAt: "desc" }, { id: "desc" }],
  });
}

/** The run's workspace's invite with the id, or null, in the caller's run. */
export function inviteInRun(id: string): Promise<Invite | null> {
  return tenantClient.invite.findFirst({ where: { id } });
}

/** The invite revoked by the user, where it is neither accepted nor revoked yet, in the caller's run. */
export async function markRevoked(id: string, userId: string, at: Date): Promise<Invite | null> {
  const [revoked] = await tenantClient.invite.updateManyAndReturn({
    where: { id, acceptedAt: null, revokedAt: null },
    data: { revokedAt: at, revokedBy: userId },
  });
  return revoked ?? null;
}

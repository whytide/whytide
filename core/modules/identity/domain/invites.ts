// identity's invites (README.md "Invites"): createInvite, which `pnpm invite` and POST /invites run,
// in a run of the invite's workspace that it opens (store.ts); revokeInvite and listInvites, which
// the Invites screen's routes run in the request's run. On a database with no organization yet, the
// invite command first makes one (bootstrapFirstWorkspace). Open, expired and revoked are read at
// the module's time (clock.ts), the rules in rules.ts.
import { AppError, newId, type Role } from "@whytide/platform";
import {
  bootstrapOrganization,
  findActiveMembership,
  findUserByEmail,
  findWorkspace,
  hasOrganization,
  settings,
  errors as tenancyErrors,
  upsertUser,
  type Workspace,
} from "@whytide/tenancy";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import { now } from "./clock.ts";
import {
  decideInvite,
  expiryFrom,
  type InviteState,
  inviteState,
  requireEmail,
  requireInviteId,
  requireRole,
} from "./rules.ts";
import { inviteInRun, invitesNotAccepted, inWorkspace, markRevoked } from "./store.ts";

export type Invite = {
  readonly id: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly role: Role;
  readonly invitedBy: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
  readonly mailedAt: Date | null;
};
/** An invite not accepted, as the Invites screen lists it, with its state when it was read. */
export type ListedInvite = Invite & { readonly state: Exclude<InviteState, "accepted"> };

/**
 * An invite of the email, lowercased, to the workspace with the role, by `invitedBy` (null for the
 * invite command): a new one, or the workspace's row for the email renewed when it is expired,
 * revoked, or accepted by a user who is no longer an active member, with a new expiry, the role and
 * the inviter, and its revoke, acceptance and mail cleared. Refused, writing nothing:
 * identity_input_invalid naming `email` or `role` (Admin included); workspace_not_found, tenancy's;
 * invite_exists for an open invite, also when another call wins the race; already_member when the
 * email's user is an active member of the workspace.
 */
export async function createInvite(input: {
  workspaceId: string;
  email: string;
  role: Role;
  invitedBy: string | null;
}): Promise<Invite> {
  const email = requireEmail(input.email);
  const role = requireRole(input.role);
  const workspace = await findWorkspace(input.workspaceId);
  if (workspace === null) throw new AppError(tenancyErrors.workspace_not_found);
  // Before the run: tenancy reads the global users outside any (nested_run otherwise).
  const user = await findUserByEmail(email);
  const at = now();
  const fields = { role, invitedBy: input.invitedBy, expiresAt: expiryFrom(at) };
  const invite = await inWorkspace(workspace.id, async (tx) => {
    const existing = await tx.invite.findFirst({ where: { email } });
    // tenancy's read in this run: the user's active membership of its workspace.
    const member = user !== null && (await findActiveMembership(user.id)) !== null;
    const decision = decideInvite(existing, member, at);
    if (decision === "already_member") throw new AppError(errors.already_member);
    if (decision === "create") {
      // INSERT … ON CONFLICT DO NOTHING: no row back when another call made it first.
      const row = { id: newId(ids.invite), workspaceId: workspace.id, email, ...fields };
      const [made] = await tx.invite.createManyAndReturn({ data: [row], skipDuplicates: true });
      return made;
    }
    if (decision === "renew" && existing !== null) {
      // Only while it is still not open: of two renewals at once, the second matches no row.
      const notOpen = [
        { acceptedAt: { not: null } },
        { revokedAt: { not: null } },
        { expiresAt: { lte: at } },
      ];
      const cleared = { acceptedAt: null, revokedAt: null, revokedBy: null, mailedAt: null };
      const [renewed] = await tx.invite.updateManyAndReturn({
        where: { id: existing.id, OR: notOpen },
        data: { ...fields, ...cleared },
      });
      return renewed;
    }
    return undefined;
  });
  if (invite === undefined) throw new AppError(errors.invite_exists);
  return invite;
}

/**
 * The invite revoked by the user, in the caller's tenant run: revoked_at and revoked_by set, so it
 * lets no one in from then on. invite_not_found for an id the run's workspace does not hold;
 * invite_accepted once it made its membership; a revoked one is answered unchanged.
 */
export async function revokeInvite(inviteId: string, userId: string): Promise<Invite> {
  const id = requireInviteId(inviteId);
  const found = await inviteInRun(id);
  if (found === null) throw new AppError(errors.invite_not_found);
  if (found.acceptedAt !== null) throw new AppError(errors.invite_accepted);
  if (found.revokedAt !== null) return found;
  const revoked = await markRevoked(id, userId, now());
  if (revoked !== null) return revoked;
  // Accepted or revoked since the read, by another call.
  const after = await inviteInRun(id);
  if (after === null) throw new AppError(errors.invite_not_found);
  if (after.acceptedAt !== null) throw new AppError(errors.invite_accepted);
  return after;
}

/** The run's workspace's invites not accepted, the latest made or renewed first, each with its state. */
export async function listInvites(): Promise<ListedInvite[]> {
  const at = now();
  return (await invitesNotAccepted()).flatMap((invite) => {
    const state = inviteState(invite, at);
    return state === "accepted" ? [] : [{ ...invite, state }];
  });
}

/**
 * The first organization and its workspace, on a database with none yet (decisions.md): tenancy's
 * bootstrapOrganization from ORGANIZATION_NAME and WORKSPACE_SLUG, the email's user their Owner.
 * Null once any organization exists: an invite then joins the workspace it names.
 */
export async function bootstrapFirstWorkspace(value: string): Promise<Workspace | null> {
  const email = requireEmail(value);
  if (await hasOrganization()) return null;
  const owner = await upsertUser({ email });
  const name = settings.ORGANIZATION_NAME;
  const workspaceSlug = settings.WORKSPACE_SLUG;
  return (await bootstrapOrganization({ name, workspaceSlug, ownerUserId: owner.id })).workspace;
}

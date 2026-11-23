// Accepting an invite (README.md "Invites"): by the first sign-in of its email (sign-in.ts), and by a
// user who has an account already, on the Invitations page (POST /v1/invitations/{id}/accept). The
// session proves the address, so an invite is accepted only by a user whose email it names, while it
// is open; no token travels in a mail or a URL. Anything else is invite_not_found, which never says
// whose invite it is or that one exists.
import { AppError, type Role } from "@whytide/platform";
import { addMember, findUser, findWorkspace, listMemberships } from "@whytide/tenancy";
import { errors } from "../errors.ts";
import { now } from "./clock.ts";
import type { Invite } from "./invites.ts";
import { requireInviteId } from "./rules.ts";
import { inWorkspace, pendingInvitesOf } from "./store.ts";

/** Where an accepted invite lands: its workspace, by id and slug. */
export type Accepted = { readonly workspaceId: string; readonly slug: string };
/** An open invite as its invitee sees it on the Invitations page. */
export type Invitation = {
  readonly id: string;
  readonly workspaceName: string;
  readonly role: Role;
  /** The inviter's display name or email; null for the invite command. */
  readonly invitedByName: string | null;
  readonly expiresAt: Date;
};

/**
 * The user's own open invites, oldest first, read by their email through pendingInvitesOf, the one
 * read across workspaces, with each workspace's name and the inviter's; none for a user who is
 * unknown or disabled.
 */
export async function invitationsOf(userId: string): Promise<Invitation[]> {
  const user = await findUser(userId);
  if (user === null || user.disabledAt !== null) return [];
  const listed: Invitation[] = [];
  for (const { id, workspaceId, role, invitedBy, expiresAt } of await pendingInvitesOf(
    user.email,
  )) {
    const workspace = await findWorkspace(workspaceId);
    if (workspace === null) continue; // no foreign key: a workspace gone takes its invites' use
    const inviter = invitedBy === null ? null : await findUser(invitedBy);
    const invitedByName = inviter && (inviter.displayName ?? inviter.email);
    listed.push({ id, workspaceName: workspace.name, role, invitedByName, expiresAt });
  }
  return listed;
}

/**
 * The membership with the invite's role first (tenancy's addMember, which makes a removed member
 * active again), then the invite marked accepted: a failure between the two leaves the invite open,
 * and the next sign-in or accept ends it. A revoke between the two leaves the membership; the mark
 * then matches no row, as an invite is never both accepted and revoked.
 */
export async function joinWorkspace(invite: Invite, userId: string): Promise<void> {
  const { id, workspaceId, role } = invite;
  await addMember({ userId, workspaceId, role });
  await inWorkspace(workspaceId, (tx) =>
    tx.invite.updateMany({
      where: { id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: now() },
    }),
  );
}

/**
 * The user's open invite with the id accepted: its membership, with the invite's role. A second
 * accept by the same user, of an invite accepted already, answers the same workspace while they are
 * an active member of it, read in their own workspaces' runs. invite_not_found for anything else: no
 * invite with the id, another email's, expired, revoked, or a user who is unknown or disabled.
 */
export async function acceptInvite(input: { inviteId: string; userId: string }): Promise<Accepted> {
  const inviteId = requireInviteId(input.inviteId);
  const user = await findUser(input.userId);
  if (user === null || user.disabledAt !== null) throw new AppError(errors.invite_not_found);
  const open = (await pendingInvitesOf(user.email)).find((invite) => invite.id === inviteId);
  if (open !== undefined) {
    await joinWorkspace(open, user.id);
    const workspace = await findWorkspace(open.workspaceId);
    if (workspace === null) throw new AppError(errors.invite_not_found);
    return { workspaceId: workspace.id, slug: workspace.slug };
  }
  for (const { workspaceId, slug } of await listMemberships(user.id)) {
    const accepted = await inWorkspace(workspaceId, (tx) =>
      tx.invite.findFirst({
        where: { id: inviteId, email: user.email, acceptedAt: { not: null } },
        select: { id: true },
      }),
    );
    if (accepted !== null) return { workspaceId, slug };
  }
  throw new AppError(errors.invite_not_found);
}

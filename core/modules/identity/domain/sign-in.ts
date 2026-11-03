// Who may sign in, and the first sign-in (README.md "Sign-in"): the authentication port's hooks,
// through api/hooks.ts. An invited email or a member's may sign in, unless its user is disabled;
// when the link is followed, the email's pending invites are accepted. users and memberships are
// tenancy's, through its commands.
import { AppError } from "@whytide/platform";
import {
  addMember,
  disableUser,
  findUserByEmail,
  listMemberships,
  upsertUser,
} from "@whytide/tenancy";
import { errors } from "../errors.ts";
import type { Invite } from "./invites.ts";
import { normalizeEmail } from "./rules.ts";
import { inWorkspace, pendingInvitesOf } from "./store.ts";

/** A user as the authentication port's users hook answers: the id, and since when it is disabled. */
export type SignInUser = { id: string; disabledAt: Date | null };

/**
 * True for an email invited to a workspace and not accepted yet, or whose user is a member of one;
 * false for a disabled user, invited or not. It writes nothing.
 */
export async function allowSignIn(value: string): Promise<boolean> {
  const email = normalizeEmail(value);
  if (email === null) return false;
  const user = await findUserByEmail(email);
  if (user?.disabledAt) return false;
  if ((await pendingInvitesOf(email)).length > 0) return true;
  return user !== null && (await listMemberships(user.id)).length > 0;
}

/** The user with the email, or null; it creates nothing. A disabled user is sent no link. */
export async function findByEmail(value: string): Promise<SignInUser | null> {
  const email = normalizeEmail(value);
  const user = email === null ? null : await findUserByEmail(email);
  return user && { id: user.id, disabledAt: user.disabledAt };
}

/** Disables the user (tenancy's disableUser): the authentication port's revokeUser calls it. */
export async function disable(userId: string): Promise<void> {
  await disableUser(userId);
}

/**
 * The user with the email, asked for when a link is followed. The first sign-in of an invited email
 * creates the user; each pending invite is then accepted, its membership made with the invite's
 * role; a sign-in after that creates nothing. An email with neither an invite nor a user is
 * invite_required and creates nothing (allowSignIn refused it already). A disabled user comes back
 * with its disabledAt, which the adapter refuses, and accepts no invite.
 */
export async function findOrCreateByEmail(value: string): Promise<SignInUser> {
  const email = normalizeEmail(value);
  if (email === null) throw new AppError(errors.invite_required);
  const found = await findUserByEmail(email);
  if (found?.disabledAt) return { id: found.id, disabledAt: found.disabledAt };
  const invites = await pendingInvitesOf(email);
  if (found === null && invites.length === 0) throw new AppError(errors.invite_required);
  const user = found ?? (await upsertUser({ email }));
  for (const invite of invites) await accept(invite, user.id);
  return { id: user.id, disabledAt: user.disabledAt };
}

/** The membership first, then the mark: a failure between the two leaves the invite pending, and the next sign-in ends it. */
async function accept({ id, workspaceId, role }: Invite, userId: string): Promise<void> {
  await addMember({ userId, workspaceId, role });
  await inWorkspace(workspaceId, (tx) =>
    tx.invite.updateMany({ where: { id, acceptedAt: null }, data: { acceptedAt: new Date() } }),
  );
}

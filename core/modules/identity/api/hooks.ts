// What the api host reads of identity (core/apps/api/README.md "Modules"): the workspace resolver,
// which the workspace guard asks on every workspace route, and the authentication port's hooks,
// which the host passes to auth.configure() at start. The routes are invites.controller.ts' and
// invitations.controller.ts'.
import type { Principal, Role } from "@whytide/platform";
import { type AuthHooks, appMailConfig, appMailPort, getAdapter } from "@whytide/providers";
import { resolveMembership } from "@whytide/tenancy";
import { allowSignIn, disable, findByEmail, findOrCreateByEmail } from "../domain/sign-in.ts";

/**
 * The principal's membership of the workspace the URL names, by id or slug, or null: the user's own
 * memberships read once per request (and the workspaces for a slug), never cached.
 */
export async function workspaceResolver(input: {
  readonly principal: Principal;
  readonly workspace: string;
}): Promise<{ workspaceId: string; membershipId: string; role: Role } | null> {
  const userId = input.principal.userId;
  const found = await resolveMembership({ userId, workspaceIdOrSlug: input.workspace });
  return found && { workspaceId: found.workspaceId, membershipId: found.id, role: found.role };
}

/** The app-mail port's instance, resolved at the first mail; getAdapter keeps one per process. */
const mail: AuthHooks["mail"] = {
  send: async (message) =>
    (await getAdapter(appMailPort, appMailConfig.PROVIDER_APP_MAIL)).send(message),
};

export const authHooks: AuthHooks = {
  allowSignIn,
  mail,
  users: { findOrCreateByEmail, findByEmail, disable },
};

// identity's invite command (README.md "The invite command"): createInvite, which `pnpm invite` runs
// and the invite screen will; the row is written in a run of the invite's workspace (store.ts). On a
// database with no organization yet, the command first makes one (bootstrapFirstWorkspace).
import { AppError, newId, type Role } from "@whytide/platform";
import {
  bootstrapOrganization,
  findWorkspace,
  hasOrganization,
  settings,
  errors as tenancyErrors,
  upsertUser,
  type Workspace,
} from "@whytide/tenancy";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import { requireEmail } from "./rules.ts";
import { inWorkspace } from "./store.ts";

export type Invite = {
  readonly id: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly role: Role;
  readonly invitedBy: string | null;
  readonly createdAt: Date;
  readonly acceptedAt: Date | null;
};

/**
 * An invite of the email, lowercased, to the workspace as Owner. invite_exists when the workspace has
 * one for the email already, accepted or not, also when another call wins a race: nothing is written
 * then. workspace_not_found, tenancy's, when no workspace has the id.
 */
export async function createInvite(input: { workspaceId: string; email: string }): Promise<Invite> {
  const email = requireEmail(input.email);
  const workspace = await findWorkspace(input.workspaceId);
  if (workspace === null) throw new AppError(tenancyErrors.workspace_not_found);
  const row = { id: newId(ids.invite), workspaceId: workspace.id, email };
  // INSERT … ON CONFLICT DO NOTHING: on the unique (workspace_id, email) it returns no row.
  const [invite] = await inWorkspace(workspace.id, (tx) =>
    tx.invite.createManyAndReturn({ data: [row], skipDuplicates: true }),
  );
  if (invite === undefined) throw new AppError(errors.invite_exists);
  return invite;
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

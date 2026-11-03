// tenancy's test factories (README.md "Testing"), `@whytide/tenancy/testing`, for tests only: rows
// written on asRole("app") of @whytide/db/testing, so the test file calls withTestDb() first. Ids,
// emails and slugs are new on every call; names are synthetic. useTenancyClient(asRole("app")) makes
// the module's own commands run in the test file's schema too.
import { asRole } from "@whytide/db/testing";
import { newId, type Role, synthetic } from "@whytide/platform";
import type { Membership, Organization, User, Workspace } from "../domain/commands.ts";
import { ids } from "../ids.ts";

export { useClient as useTenancyClient } from "../domain/store.ts";

/** A workspace of its own organization, with its Owner. */
export type TestTenant = {
  readonly user: User;
  readonly organization: Organization;
  readonly workspace: Workspace;
  readonly membership: Membership;
};

let made = 0;
const names = () => synthetic(`tenancy-${++made}`);

function newUser(): User {
  const id = newId(ids.user);
  const name = names();
  const displayName = `${name.firstName()} ${name.lastName()}`;
  const email = `${id.toLowerCase()}@example.com`;
  return { id, email, displayName, locale: null, createdAt: new Date(), disabledAt: null };
}

/** An organization and its workspace, sharing a name and a slug, as bootstrapOrganization makes them. */
function newOrganization(workspaceId: string = newId(ids.workspace)) {
  const id = newId(ids.organization);
  const slug = `w${id.slice(-12).toLowerCase()}`;
  const name = names().company();
  const createdAt = new Date();
  const organization: Organization = { id, name, slug, createdAt };
  const workspace: Workspace = { id: workspaceId, organizationId: id, name, slug, createdAt };
  return { organization, workspace };
}

function newMembership(userId: string, workspaceId: string, role: Role = "Owner"): Membership {
  return { id: newId(ids.membership), workspaceId, userId, role, createdAt: new Date() };
}

export function createUser(): Promise<User> {
  return asRole("app").user.create({ data: newUser() });
}

/** An organization with one workspace, with the id given (the isolation harness names its own). */
export async function createOrganizationWithWorkspace(
  options: { workspaceId?: string } = {},
): Promise<{ organization: Organization; workspace: Workspace }> {
  const app = asRole("app");
  const { organization, workspace } = newOrganization(options.workspaceId);
  await app.organization.create({ data: organization });
  return { organization, workspace: await app.workspace.create({ data: workspace }) };
}

export function createMembership(input: {
  userId: string;
  workspaceId: string;
  role?: Role;
}): Promise<Membership> {
  const { userId, workspaceId, role } = input;
  return asRole("app").membership.create({ data: newMembership(userId, workspaceId, role) });
}

/** Two workspaces in two organizations with one Owner each, written in one batch. */
export async function createTwoWorkspaces(): Promise<readonly [TestTenant, TestTenant]> {
  const tenant = (): TestTenant => {
    const user = newUser();
    const { organization, workspace } = newOrganization();
    return { user, organization, workspace, membership: newMembership(user.id, workspace.id) };
  };
  const tenants = [tenant(), tenant()] as const;
  const app = asRole("app");
  await app.$transaction([
    app.user.createMany({ data: tenants.map((t) => t.user) }),
    app.organization.createMany({ data: tenants.map((t) => t.organization) }),
    app.workspace.createMany({ data: tenants.map((t) => t.workspace) }),
    app.membership.createMany({ data: tenants.map((t) => t.membership) }),
  ]);
  return tenants;
}

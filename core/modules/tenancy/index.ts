// The public interface of tenancy (README.md): the commands and queries other modules call, the types
// they return, the registries the hosts load, `accountApi`, GET /v1/me, which the api host mounts
// under /v1, and `api`, the members routes, mounted under /v1/workspaces/:workspaceId/tenancy.
// Nothing else in this module is importable from outside it (docs/rules/coding.md §2).
export { AccountApi as accountApi } from "./api/me.controller.ts";
export { MembersApi as api } from "./api/members.controller.ts";
export {
  addMember,
  addOwner,
  bootstrapOrganization,
  changeRole,
  createWorkspace,
  disableUser,
  findActiveMembership,
  findOrganization,
  findOrganizationBySlug,
  findUser,
  findUserByEmail,
  findWorkspace,
  findWorkspaceBySlug,
  hasOrganization,
  listMembers,
  listMemberships,
  listWorkspaceIds,
  type Member,
  type Membership,
  type MembershipListing,
  type Organization,
  removeMember,
  resolveMembership,
  sharingGroupOf,
  type User,
  upsertUser,
  type Workspace,
  workspaceOwner,
} from "./domain/commands.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";
export { settings } from "./settings.ts";

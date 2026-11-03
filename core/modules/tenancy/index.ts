// The public interface of tenancy (README.md): the commands and queries other modules call, the types
// they return, the registries the hosts load, and `accountApi`, GET /v1/me, which the api host mounts
// under /v1. Nothing else in this module is importable from outside it (docs/rules/coding.md §2).
export { AccountApi as accountApi } from "./api/me.controller.ts";
export {
  addMember,
  addOwner,
  bootstrapOrganization,
  createWorkspace,
  disableUser,
  findOrganization,
  findOrganizationBySlug,
  findUser,
  findUserByEmail,
  findWorkspace,
  findWorkspaceBySlug,
  hasOrganization,
  listMemberships,
  listWorkspaceIds,
  type Membership,
  type MembershipListing,
  type Organization,
  resolveMembership,
  type User,
  upsertUser,
  type Workspace,
} from "./domain/commands.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";
export { settings } from "./settings.ts";

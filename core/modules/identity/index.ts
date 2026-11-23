// The public interface of identity (README.md "Public interface"): the two hooks the api host reads;
// `api`, the Invites screen's routes, mounted under /v1/workspaces/:workspaceId/identity, and
// `accountApi`, the Invitations page's, under /v1; the invite commands and the registries. Nothing
// else in this module is importable from outside it (docs/rules/coding.md §2).
export { authHooks, workspaceResolver } from "./api/hooks.ts";
export { InvitationsApi as accountApi } from "./api/invitations.controller.ts";
export { InvitesApi as api } from "./api/invites.controller.ts";
export { type Accepted, acceptInvite } from "./domain/accept.ts";
export {
  createInvite,
  type Invite,
  type ListedInvite,
  listInvites,
  revokeInvite,
} from "./domain/invites.ts";
export { errors } from "./errors.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";

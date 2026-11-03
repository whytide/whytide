// The public interface of identity (README.md "Public interface"): the two hooks the api host reads,
// the invite command and the registries. Nothing else in this module is importable from outside it
// (docs/rules/coding.md §2).
export { authHooks, workspaceResolver } from "./api/hooks.ts";
export { createInvite, type Invite } from "./domain/invites.ts";
export { errors } from "./errors.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";

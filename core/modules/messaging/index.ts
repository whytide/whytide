// The public interface of messaging (README.md): `api`, the dossier route the api host mounts under
// /v1/workspaces/:workspaceId/messaging, the person's erasure the deletion script calls, the
// drafts' source of the grounding sample, which loading this file defines (alpha-p10-050), and the
// registries the hosts load. Nothing else in this module is importable from outside it
// (docs/rules/coding.md §2); the agents' task files are loaded by the hosts (loadAgentTasks).
export { MessagingApi as api } from "./api/module.ts";
export { draftSample } from "./domain/drafts/grounding.ts";
export { erasePerson } from "./domain/drafts/store.ts";
export { errors } from "./errors.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";
export { settings } from "./settings.ts";

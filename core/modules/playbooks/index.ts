// The public interface of playbooks (README.md "Public interface"): the agents' readers, the command
// signals calls when a source is deleted, the source checker's registration, the registries the hosts
// load, and `api`, the routes the api host mounts under /v1/workspaces/:workspaceId/playbooks.
// Nothing else in this module is importable from outside it (docs/rules/coding.md §2).
export { PlaybooksApi as api } from "./api/playbooks.controller.ts";
export {
  detachSource,
  getPlaybook,
  type ListedPlaybook,
  listPlaybooks,
  type Playbook,
  playbookOfSource,
  sourcesOf,
} from "./domain/playbooks.ts";
export {
  defineSourceChecker,
  type SourceCheck,
  type SourceChecker,
} from "./domain/source-checker.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";

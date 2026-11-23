// The public interface of icp (README.md "Public interface"): the query qualification calls, the
// audiences' reads and their types, the registries the hosts load, and `api`, the routes the api host
// mounts under /v1/workspaces/:workspaceId/icp. Nothing else in this module is importable from
// outside it (docs/rules/coding.md §2).
export { IcpApi as api } from "./api/icp.controller.ts";
export {
  type Audience,
  type AudienceSummary,
  findAudience,
  type Icp,
  type IcpForScoring,
  listAudiences,
  readIcpForScoring,
} from "./domain/commands.ts";
export type { Criterion, CriterionKey, Seniority, SizeRange } from "./domain/lists.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";

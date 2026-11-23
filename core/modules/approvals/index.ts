// The public interface of approvals (README.md): `api`, the queue's routes the api host mounts under
// /v1/workspaces/:workspaceId/approvals; campaigns' commands and queries on a step's item (openItem,
// cancelItems, noteItemWait, approvedContent, decisionsFor), an email's and the mode's included
// (gamma-p4-090), the mode taken back (returnModeItems, gamma-p4-070), and its queue window as
// configured (queueWindowHours, settings.ts); the edit report and the decision days; the person's
// erasure, which privacy registers; and the registries the hosts load. Nothing else in this module
// is importable from outside it (docs/rules/coding.md §2).
export { ApprovalsApi as api } from "./api/module.ts";
export { erasePerson } from "./domain/erase.ts";
export { cancelItems, returnModeItems } from "./domain/items/cancel.ts";
export { type OpenItemInput, openItem } from "./domain/items/open.ts";
export {
  type ApprovedContentOptions,
  type ApprovedStep,
  type ApprovedStepWithOrigin,
  approvedContent,
  decisionDays,
  decisionsFor,
  editStats,
  type StepDecision,
} from "./domain/items/queries.ts";
export type { DecisionDay, EditStats } from "./domain/items/rules.ts";
export { type ItemWait, noteItemWait } from "./domain/items/wait.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";
export { queueWindowHours } from "./settings.ts";

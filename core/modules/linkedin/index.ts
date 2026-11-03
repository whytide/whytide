// The public interface of linkedin (README.md): the api the host mounts under
// /v1/workspaces/:workspaceId/linkedin, the webhook it mounts at /v1/linkedin/webhooks/:provider, the
// sender account check, the read quota, the action log and the engager and profile reads' types the
// signal run reads through, the events other modules subscribe to, and the registries the hosts load.
// Nothing else in this module is importable from outside it (docs/rules/coding.md §2); the worker
// loads workflows/ itself.
export { LinkedinApi as api } from "./api/accounts.controller.ts";
export { webhooks } from "./api/webhooks.ts";
export { findAccount as findSenderAccount, type SenderAccount } from "./domain/accounts.ts";
export { logAction } from "./domain/action-log/log.ts";
export {
  commitReads,
  type Refusal,
  type Reservation,
  releaseReads,
  reserveReads,
} from "./domain/quota/reservations.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";
export {
  type EngagersFile,
  type EngagersPage,
  type EngagersRefused,
  engagersFile,
  type ReadPostEngagers,
} from "./schemas/engagers.ts";
export {
  type ProfileFile,
  type ProfileRead,
  type ProfileRefused,
  profileFile,
  profileRequestFile,
  type ReadProfile,
} from "./schemas/profile.ts";

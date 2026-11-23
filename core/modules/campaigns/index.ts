// The public interface of campaigns (README.md): the api the host mounts under
// /v1/workspaces/:workspaceId/campaigns, the eraser privacy's deletion script runs and the lock its
// lead deletion takes, the hold inbox runs on a reply, an enrollment's pause and resume (gamma-p4-050's
// out-of-office pause), a reply label's default action and the labels (applyReplyLabel,
// REPLY_ACTION_LABELS, gamma-p4-050), a sent step's ids (sentStep), and the registries the hosts
// load, with the subscriptions to contacts' events, the price of a send and its setting.
// Nothing else in this module is importable from outside it (docs/rules/coding.md §2).
export { CampaignsApi as api } from "./api/module.ts";
export { erasePerson, lockPersonSteps } from "./domain/erase.ts";
export { holdForReply } from "./domain/hold.ts";
export { pauseEnrollment, resumeEnrollment } from "./domain/pause/enrollment.ts";
export {
  applyReplyLabel,
  type ReplyActionsTaken,
  type ReplyLabelInput,
} from "./domain/replies/apply.ts";
export {
  REPLY_ACTION_LABELS,
  type ReplyAction,
  type ReplyActionLabel,
} from "./domain/replies/constants.ts";
export { type SentStep, sentStep } from "./domain/send/sent.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";
export { prices } from "./prices.ts";
export { settings } from "./settings.ts";

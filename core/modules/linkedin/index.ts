// The public interface of linkedin (README.md): the api the host mounts under
// /v1/workspaces/:workspaceId/linkedin, the webhook it mounts at /v1/linkedin/webhooks/:provider, the
// sender account check, the read quota and the reads left today, the action log and the engager,
// profile and posts reads' types the signal run reads through, the user's sender, what it may send
// today, the send reservations and the error map for campaigns, the reply signal campaigns' gate
// reads (lastInboundAt), the kept messages' file, the sends and the warnings campaigns' report reads,
// the eraser privacy registers, a company page's read for enrichment (readCompany, in the worker),
// a lead's "Contact info" emails for an email lookup and its switch (readContactEmails, in the
// worker, and contactInfoEnabled; gamma-en-087),
// the events other modules subscribe to, and the registries the hosts load. Nothing else in this module is importable from outside it (docs/rules/coding.md §2); the
// worker loads workflows/ itself.
export { LinkedinApi as api } from "./api/accounts.controller.ts";
export { webhooks } from "./api/webhooks.ts";
export {
  findAccount as findSenderAccount,
  type SenderAccount,
  senderOf,
} from "./domain/accounts.ts";
export { logAction } from "./domain/action-log/log.ts";
export { type SendLogRow, sendLogRows } from "./domain/action-log/sends.ts";
export {
  type CompanyRead,
  type CompanyReadContext,
  readCompany,
} from "./domain/company/read.ts";
export {
  type ContactRead,
  type ContactReadContext,
  readContactEmails,
} from "./domain/contact/read.ts";
export { contactInfoEnabled } from "./domain/contact/switch.ts";
export { sendingDisclosureRequired } from "./domain/disclosure/disclosure.ts";
export { erasePerson } from "./domain/erase.ts";
export { type HealthEventRow, healthEventsSince } from "./domain/health/events.ts";
export {
  commitReads,
  type ReadsLeft,
  type Refusal,
  type RemainingToday,
  type Reservation,
  readsLeftToday,
  releaseReads,
  remainingToday,
  reserveReads,
} from "./domain/quota/reservations.ts";
export { lastInboundAt } from "./domain/receiver/last-inbound.ts";
export { SEND_REFUSED_REASONS, type SendRefusedReason } from "./domain/send/constants.ts";
export { SEND_ERROR_MAP, type SendErrorMap, sendAnswerOf } from "./domain/send/error-map.ts";
export { sentMessageRef } from "./domain/send/outreach.ts";
export { findSendReservation } from "./domain/send/readers.ts";
export { reserveSend, type SendRefusal, type SendReservation } from "./domain/send/reserve.ts";
export { commitSend, releaseSend } from "./domain/send/settle.ts";
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
  type PostsFile,
  type PostsRead,
  type PostsRefused,
  type PostsRequestFile,
  postsFile,
  postsRequestFile,
  type ReadPosts,
} from "./schemas/posts.ts";
export {
  type ProfileFile,
  type ProfileRead,
  type ProfileRefused,
  profileFile,
  profileRequestFile,
  type ReadProfile,
} from "./schemas/profile.ts";
export { type MessageFile, messageFile } from "./schemas/receiver.ts";
export {
  type CheckReplyResult,
  type CheckSentResult,
  type SendRequestFile,
  type SendResult,
  sendRequestFile,
} from "./schemas/send.ts";

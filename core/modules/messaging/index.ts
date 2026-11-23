// The public interface of messaging (README.md): `api`, the dossier route the api host mounts under
// /v1/workspaces/:workspaceId/messaging, the person's erasure the deletion script calls, the
// drafts' source of the grounding sample, which loading this file defines (alpha-p10-050), a
// sequence step's draft for campaigns and its events for approvals (beta-p3-010), the gates a text
// that may be sent passes and approvals' path that freezes a step's draft (beta-p3-020), the
// campaign's mode's approval with its AI disclosure line (gamma-p4-080) and its taking back
// (gamma-p4-070), inbox's reply writer with
// its conversation's bound (inbox-reply-draft), and the registries the hosts load. Nothing else in this module is importable from outside it (docs/rules/coding.md §2);
// the agents' task files are loaded by the hosts (loadAgentTasks).
export { MessagingApi as api } from "./api/module.ts";
export {
  type ApprovedContent,
  type ApproveStepDraftByModeInput,
  type ApproveStepDraftInput,
  approvedContent,
  approveStepDraft,
  approveStepDraftByMode,
  reopenModeApproval,
  type StepDraftApproval,
  type StepDraftModeApproval,
} from "./domain/drafts/approve.ts";
export { draftSample } from "./domain/drafts/grounding.ts";
export { requestStepDraft, type StepDraft, stepDrafts } from "./domain/drafts/step.ts";
export { erasePerson } from "./domain/drafts/store.ts";
export { checkText, type TextCheck, type TextCheckInput } from "./domain/gates/check-text.ts";
export type { ChatMessage } from "./domain/replies/chat.ts";
export { REPLY_CHAT_MAX } from "./domain/replies/constants.ts";
export {
  type ReplyFailureCode,
  type ReplyWritten,
  type WriteReplyRequest,
  writeReply,
} from "./domain/replies/write.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";
export type { GateIssue } from "./schemas/writer.ts";
export { settings } from "./settings.ts";

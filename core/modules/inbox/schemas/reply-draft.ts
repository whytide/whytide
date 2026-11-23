// The reply draft's shapes (README.md "API", "The reply draft"; core/apps/api/README.md "OpenAPI and
// the client"): the member's optional brief, REPLY_BRIEF_MAX once trimmed (the route's run checks
// it, reply_brief_too_long), and a thread's draft: its state, the writer's text once ready, a
// failure's code, when it was asked. Never the brief, the model or the decision record. The brief and
// the text are personal data: the row's, never an event, a workflow's input or a log line.
import { z } from "zod";
import { REPLY_TEXT_MAX } from "../domain/reply/constants.ts";
import { REPLY_BRIEF_BODY_MAX, REPLY_DRAFT_STATUSES } from "../domain/reply-draft/constants.ts";

export const replyDraftBody = z.strictObject({
  brief: z.string().max(REPLY_BRIEF_BODY_MAX).optional(),
});
export type ReplyDraftBody = z.output<typeof replyDraftBody>;
export const replyDraftResponse = z.strictObject({
  status: z.enum([...REPLY_DRAFT_STATUSES, "none"]),
  text: z.string().max(REPLY_TEXT_MAX).nullable(),
  error: z.string().nullable(),
  requestedAt: z.iso.datetime().nullable(),
});
export type ReplyDraftResponse = z.output<typeof replyDraftResponse>;

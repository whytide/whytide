// The reply draft's routes (README.md "API", "The reply draft"), which the api host mounts under
// /v1/workspaces/:workspaceId/inbox: thin handlers over domain/reply-draft/request.ts, inside the
// request's tenant run, both under inbox.reply, the caller's own thread only. The request writes the
// draft's row and its event, and calls no model: the worker's inbox_draft_reply writes it. It takes
// an Idempotency-Key, so two presses with one key ask once. A module cannot import the host, so each
// route sets the host's metadata itself: its permission, the key and its @ApiRoute.
import { Body, Controller, Get, HttpCode, Param, Post, SetMetadata } from "@nestjs/common";
import { errors as contactsErrors } from "@whytide/contacts";
import { readReplyDraft, requestReplyDraft } from "../domain/reply-draft/request.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type ReplyDraftBody,
  type ReplyDraftResponse,
  replyDraftBody,
  replyDraftResponse,
} from "../schemas/reply-draft.ts";
import { idParams } from "../schemas/threads.ts";

const canReply = SetMetadata("whytide:permission", permissions["inbox.reply"]);
const idempotent = SetMetadata("whytide:idempotent", true);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);

@Controller()
export class ReplyDraftsController {
  @Post("threads/:id/reply-draft")
  @HttpCode(202)
  @canReply
  @idempotent
  @route({
    summary:
      "Asks the AI for a draft of the caller's reply on their own thread, from the conversation, the lead's dossier and an optional brief: 202 with the thread's draft, drafting. A draft still drafting is answered as it is; a later one replaces it. Nothing is sent",
    params: idParams,
    body: replyDraftBody,
    response: replyDraftResponse,
    errors: [
      errors.thread_not_found,
      errors.reply_channel_unavailable,
      errors.reply_brief_too_long,
      contactsErrors.person_suppressed,
    ],
  })
  async request(
    @Param("id") id: string,
    @Body() body: ReplyDraftBody,
  ): Promise<ReplyDraftResponse> {
    return requestReplyDraft(id, body.brief);
  }

  @Get("threads/:id/reply-draft")
  @canReply
  @route({
    summary:
      "The caller's own thread's reply draft: none, drafting, ready with its text, or failed with its code",
    params: idParams,
    response: replyDraftResponse,
    errors: [errors.thread_not_found],
  })
  async read(@Param("id") id: string): Promise<ReplyDraftResponse> {
    return readReplyDraft(id);
  }
}

// The reply route (README.md "API", "Replies from the inbox"), which the api host mounts under
// /v1/workspaces/:workspaceId/inbox: a thin handler over domain/reply/request.ts, inside the
// request's tenant run. It writes the reply's row and its event, and calls no provider: the worker's
// inbox_send_reply sends. It takes an Idempotency-Key, so two presses with one key make one reply.
// A module cannot import the host, so the route sets the host's metadata itself: its permission,
// the key and its @ApiRoute.
import { Body, Controller, HttpCode, Param, Post, SetMetadata } from "@nestjs/common";
import { errors as contactsErrors } from "@whytide/contacts";
import { requestReply } from "../domain/reply/request.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import { type ReplyBody, type ReplyResponse, replyBody, replyResponse } from "../schemas/reply.ts";
import { idParams } from "../schemas/threads.ts";

const canReply = SetMetadata("whytide:permission", permissions["inbox.reply"]);
const idempotent = SetMetadata("whytide:idempotent", true);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);

@Controller()
export class RepliesController {
  @Post("threads/:id/replies")
  @HttpCode(202)
  @canReply
  @idempotent
  @route({
    summary:
      "Replies on the caller's own thread, on its channel: 202 with the reply's message, sending; the worker sends it once, in the account's limits, and the thread shows it Sent or Not sent. Another member's thread is not found",
    params: idParams,
    body: replyBody,
    response: replyResponse,
    errors: [
      errors.thread_not_found,
      errors.reply_channel_unavailable,
      errors.reply_text_invalid,
      contactsErrors.person_suppressed,
    ],
  })
  async reply(@Param("id") id: string, @Body() body: ReplyBody): Promise<ReplyResponse> {
    return requestReply(id, body.text);
  }
}

// `api`, the NestJS module the api host mounts under /v1/workspaces/:workspaceId/inbox
// (core/apps/api/README.md "Modules"): the threads, a thread, a reply's label, the reply golden
// set's export, a member's reply from the inbox, and its AI draft.
import { Module } from "@nestjs/common";
import { ExportsController } from "./exports.controller.ts";
import { RepliesController } from "./replies.controller.ts";
import { ReplyDraftsController } from "./reply-drafts.controller.ts";
import { ThreadsController } from "./threads.controller.ts";

@Module({
  controllers: [ThreadsController, ExportsController, RepliesController, ReplyDraftsController],
})
export class InboxApi {}

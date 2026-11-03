// `api`, the NestJS module the api host mounts under /v1/workspaces/:workspaceId/inbox
// (core/apps/api/README.md "Modules"): the threads, a thread, a reply's label, and the reply golden
// set's export.
import { Module } from "@nestjs/common";
import { ExportsController } from "./exports.controller.ts";
import { ThreadsController } from "./threads.controller.ts";

@Module({ controllers: [ThreadsController, ExportsController] })
export class InboxApi {}

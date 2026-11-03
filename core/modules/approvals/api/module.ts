// `api`, the NestJS module the api host mounts under /v1/workspaces/:workspaceId/approvals
// (core/apps/api/README.md "Modules"): the queue's list and its two decisions.
import { Module } from "@nestjs/common";
import { ItemsController } from "./items.controller.ts";

@Module({ controllers: [ItemsController] })
export class ApprovalsApi {}

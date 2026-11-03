// `api`, the NestJS module the api host mounts under /v1/workspaces/:workspaceId/messaging
// (core/apps/api/README.md "Modules"): the dossier route and the draft routes.
import { Module } from "@nestjs/common";
import { DossierController } from "./dossier.controller.ts";
import { DraftsController } from "./drafts.controller.ts";

@Module({ controllers: [DossierController, DraftsController] })
export class MessagingApi {}

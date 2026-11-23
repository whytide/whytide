// `api`, the NestJS module the api host mounts under /v1/workspaces/:workspaceId/enrichment
// (core/apps/api/README.md "Modules"): the lead page's company facts and its "Enrich now"; the Email
// panel's address and its "Find email" and "Verify again" (gamma-en-081).
import { Module } from "@nestjs/common";
import { EnrichmentController } from "./enrichment.controller.ts";
import { WorkEmailController } from "./work-email.controller.ts";

@Module({ controllers: [EnrichmentController, WorkEmailController] })
export class EnrichmentApi {}

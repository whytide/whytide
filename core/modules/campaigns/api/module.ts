// `api`, the NestJS module the api host mounts under /v1/workspaces/:workspaceId/campaigns
// (core/apps/api/README.md "Modules"): the enrollment route of the lead page's panel and the counts
// page's route.
import { Module } from "@nestjs/common";
import { CountsController } from "./counts.controller.ts";
import { EnrollmentsController } from "./enrollments.controller.ts";

@Module({ controllers: [EnrollmentsController, CountsController] })
export class CampaignsApi {}

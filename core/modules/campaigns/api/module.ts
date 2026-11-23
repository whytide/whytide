// `api`, the NestJS module the api host mounts under /v1/workspaces/:workspaceId/campaigns
// (core/apps/api/README.md "Modules"): the enrollment route of the lead page's panel, the counts
// page's route, the Results page's funnel and the campaigns' routes, last, so that `enrollments`,
// `counts` and `funnel` are never read as a campaign's id.
import { Module } from "@nestjs/common";
import { CampaignsController } from "./campaigns.controller.ts";
import { CountsController } from "./counts.controller.ts";
import { EnrollmentsController } from "./enrollments.controller.ts";
import { FunnelController } from "./funnel.controller.ts";

@Module({
  controllers: [EnrollmentsController, CountsController, FunnelController, CampaignsController],
})
export class CampaignsApi {}

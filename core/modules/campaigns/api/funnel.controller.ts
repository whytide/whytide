// GET …/campaigns/funnel (README.md "Routes"), which the api host mounts under
// /v1/workspaces/:workspaceId/campaigns: the Results page's numbers, per campaign the member sees,
// read in the request's tenant run, so that another workspace's rows never count. It makes the
// seeded campaign first, on first use, as the campaigns' reads do, so that beta's enrollments have
// their campaign; it writes nothing else. A module cannot import the host, so the handler sets the
// host's metadata itself: its permission, and its @ApiRoute, which documents the route
// (core/apps/api/README.md).
import { Controller, Get, SetMetadata } from "@nestjs/common";
import { seedCampaign } from "../domain/campaigns/commands.ts";
import { now } from "../domain/clock.ts";
import { campaignFunnels } from "../domain/funnel.ts";
import { permissions } from "../permissions.ts";
import { type FunnelResponse, funnelResponse } from "../schemas/funnel.ts";

@Controller("funnel")
export class FunnelController {
  @Get()
  @SetMetadata("whytide:permission", permissions["campaigns.read"])
  @SetMetadata("whytide:api-route", {
    summary:
      "Per campaign the member sees, by name (a holder of campaigns.manage every one, with its owner's name; a Member her own): the people enrolled, then on LinkedIn and by email those sent to, who accepted, replied and replied positively, each enrollment once per stage",
    response: funnelResponse,
  })
  async funnel(): Promise<FunnelResponse> {
    const asOf = now();
    await seedCampaign();
    return { asOf: asOf.toISOString(), campaigns: await campaignFunnels() };
  }
}

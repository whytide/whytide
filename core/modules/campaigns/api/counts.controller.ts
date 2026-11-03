// GET …/campaigns/counts (README.md "Routes"), which the api host mounts under
// /v1/workspaces/:workspaceId/campaigns: the counts page's numbers, per sender account of the
// workspace's enrollments, read in the request's tenant run, so that another workspace's never come.
// Read-only. A module cannot import the host, so the handler sets the host's metadata itself: its
// permission, and its @ApiRoute, which documents the route (core/apps/api/README.md).
import { Controller, Get, SetMetadata } from "@nestjs/common";
import { now } from "../domain/clock.ts";
import { countsBySender } from "../domain/counts.ts";
import { permissions } from "../permissions.ts";
import { type CountsResponse, countsResponse } from "../schemas/counts.ts";

@Controller("counts")
export class CountsController {
  @Get()
  @SetMetadata("whytide:permission", permissions["campaigns.read"])
  @SetMetadata("whytide:api-route", {
    summary:
      "Per sender account of the workspace's enrollments, by label: the connection requests and messages sent, the invitations accepted and the people who replied, today, over the last 7 days and since the start, the days in the account's zone",
    response: countsResponse,
  })
  async counts(): Promise<CountsResponse> {
    const asOf = now();
    return { asOf: asOf.toISOString(), senders: await countsBySender(asOf) };
  }
}

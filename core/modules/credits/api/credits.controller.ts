// GET …/credits/balance, GET …/credits/usage, GET …/credits/prices and the cost counter's GET
// …/credits/costs and GET …/credits/leads/{personId}/cost (README "Public interface"), mounted by the
// api host under /v1/workspaces/:workspaceId/credits. Each runs in the request's tenant run, for the
// run's workspace, currentTenant(), never the id as the URL writes it; credits.read is required. The
// prices are the global list, read in the run as priceOf reads them.
import {
  Controller,
  Get,
  Module,
  type OnApplicationShutdown,
  Param,
  Query,
  SetMetadata,
} from "@nestjs/common";
import { errors as contactsErrors } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { currentTenant } from "@whytide/platform";
import { walletOf } from "../domain/balance.ts";
import { leadCost } from "../domain/costs/lead.ts";
import { weekOf } from "../domain/costs/week.ts";
import { weeklyCosts } from "../domain/costs/weekly.ts";
import { listPrices } from "../domain/prices.ts";
import { disconnectClient } from "../domain/store.ts";
import { listUsage } from "../domain/usage.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type CostsQuery,
  type CostsResponse,
  costsQuery,
  costsResponse,
  type LeadCostResponse,
  leadCostParams,
  leadCostResponse,
} from "../schemas/costs.ts";
import {
  type BalanceResponse,
  balanceResponse,
  type PricesResponse,
  pricesResponse,
  type UsageQuery,
  type UsageResponse,
  usageQuery,
  usageResponse,
} from "../schemas/credits.ts";

@Controller()
export class CreditsController {
  @Get("balance")
  @SetMetadata("whytide:permission", permissions["credits.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The credits of the workspace's organization: available, granted, reserved, committed",
    response: balanceResponse,
  })
  async balance(): Promise<BalanceResponse> {
    const { periodEnd, ...amounts } = await walletOf(tenantClient, currentTenant().workspaceId);
    return { ...amounts, periodEnd: periodEnd?.toISOString() ?? null };
  }

  @Get("usage")
  @SetMetadata("whytide:permission", permissions["credits.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The workspace's credit usage, newest first, a page at a time",
    query: usageQuery,
    response: usageResponse,
  })
  usage(@Query() query: UsageQuery): Promise<UsageResponse> {
    return listUsage(tenantClient, query);
  }

  @Get("prices")
  @SetMetadata("whytide:permission", permissions["credits.read"])
  @SetMetadata("whytide:api-route", {
    summary:
      "Every priced action's credits per unit in the price list in effect, with a rise announced for a later date",
    response: pricesResponse,
  })
  prices(): Promise<PricesResponse> {
    return listPrices(tenantClient, new Date());
  }

  @Get("costs")
  @SetMetadata("whytide:permission", permissions["credits.read"])
  @SetMetadata("whytide:api-route", {
    summary:
      "The workspace's costs in an ISO week: credits by action, vendor cost by vendor, the leads qualified and the cost per 100 of them",
    query: costsQuery,
    response: costsResponse,
    errors: [errors.credits_input_invalid],
  })
  async costs(@Query() query: CostsQuery): Promise<CostsResponse> {
    const { workspaceId } = currentTenant();
    const week = query.week ?? weekOf(new Date()).week;
    const { start, end, ...costs } = await weeklyCosts({ workspaceId, week });
    return { ...costs, start: start.toISOString(), end: end.toISOString() };
  }

  @Get("leads/:personId/cost")
  @SetMetadata("whytide:permission", permissions["credits.read"])
  @SetMetadata("whytide:api-route", {
    summary:
      "A lead's cost: its assessments' credits and calls, its drafts' calls and its share of the signal runs' reads",
    params: leadCostParams,
    response: leadCostResponse,
    errors: [contactsErrors.lead_not_found],
  })
  lead(@Param("personId") personId: string): Promise<LeadCostResponse> {
    return leadCost(personId);
  }
}

@Module({ controllers: [CreditsController] })
export class CreditsApi implements OnApplicationShutdown {
  /** Once the api's server has closed and its requests have ended, the module's own client ends. */
  async onApplicationShutdown(): Promise<void> {
    await disconnectClient();
  }
}

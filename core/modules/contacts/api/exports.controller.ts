// GET …/contacts/exports/leads.csv (README.md "Routes"): the CSV written to the answer as each page of
// leads is read (domain/export/leads-csv.ts). The route opens its own runs, one per page
// (whytide:own-runs, domain/store.ts), so that no run waits on a client that reads slowly; a client
// that leaves stops it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import {
  Controller,
  Get,
  type OnApplicationShutdown,
  Query,
  Req,
  Res,
  SetMetadata,
} from "@nestjs/common";
import type { TenantContext } from "@whytide/platform";
import { leadsCsv } from "../domain/export/leads-csv.ts";
import { disconnectClient, inRun } from "../domain/store.ts";
import { permissions } from "../permissions.ts";
import { type LeadsCsvQuery, leadsCsvQuery } from "../schemas/exports.ts";

/** The request of a whytide:own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

@Controller("exports")
export class ExportsController implements OnApplicationShutdown {
  @Get("leads.csv")
  @SetMetadata("whytide:permission", permissions["exports.read"])
  @SetMetadata("whytide:own-runs", true)
  @SetMetadata("whytide:api-route", {
    summary:
      "The leads of the list's view as a CSV file (text/csv, UTF-8 with a byte-order mark), by descending fit",
    query: leadsCsvQuery,
  })
  async leads(
    @Query() query: LeadsCsvQuery,
    @Req() req: OwnRunsRequest,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const { tenant } = req;
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (tenant === undefined) throw new Error("no tenant on an own-runs route");
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="leads-${day}.csv"`);
    res.setHeader("cache-control", "no-store");
    try {
      await pipeline(
        leadsCsv(query, (fn) => inRun(tenant, fn)),
        res,
      );
    } catch (error) {
      // The client left: nothing to answer. Anything else is the error filter's, which ends an
      // answer it cannot complete.
      if ((error as { code?: unknown }).code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await disconnectClient();
  }
}

// The Companies found routes (README.md "API"; gamma-wr-110), under …/signals/found-companies: the list
// with its filters and pages, Not a fit, and the list's view as a CSV. The CSV streams to the answer a
// page of companies at a time and opens its own runs, as contacts' leads CSV does (whytide:own-runs), so
// that no run waits on a client that reads slowly; its permission is contacts' `exports.read`, which the
// leads' file asks. A module cannot import the host, so each route sets the host's metadata itself.
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  SetMetadata,
} from "@nestjs/common";
import { withTenant } from "@whytide/db";
import type { TenantContext } from "@whytide/platform";
import { givenClient } from "../domain/client.ts";
import { FOUND_CSV_NAME } from "../domain/research/constants.ts";
import { foundCompaniesCsv } from "../domain/research/found-csv.ts";
import {
  type FoundCompany,
  listFoundCompanies,
  markNotFit,
} from "../domain/research/found-list.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type FoundCompanyResponse,
  type FoundFilterQuery,
  type FoundListQuery,
  type FoundListResponse,
  foundCompanyResponse,
  foundFilterQuery,
  foundListQuery,
  foundListResponse,
  foundParams,
} from "../schemas/found-companies.ts";

/** The request of a whytide:own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

/** contacts' action for exporting, which the CSV asks, as the leads' file does (its roles are contacts'). */
const EXPORTS_READ = "exports.read";

@Controller("found-companies")
export class FoundCompaniesController {
  @Get()
  @SetMetadata("whytide:permission", permissions["signals.read"])
  @SetMetadata("whytide:api-route", {
    summary:
      "The workspace's found companies, newest judged first, in pages: with no verdict the fit and unsure ones; filtered by source, by agent and by verdict; each with its reasons (line, quote, page, date read), the page that led to it and its source type, how to reach it and the source's label",
    query: foundListQuery,
    response: foundListResponse,
  })
  async list(@Query() query: FoundListQuery): Promise<FoundListResponse> {
    const { limit, cursor, ...filter } = query;
    const page = await listFoundCompanies(filter, { limit, cursor });
    return { companies: page.companies.map(toResponse), nextCursor: page.nextCursor };
  }

  @Get("export.csv")
  @SetMetadata("whytide:permission", EXPORTS_READ)
  @SetMetadata("whytide:own-runs", true)
  @SetMetadata("whytide:api-route", {
    summary:
      "The list's view as a CSV file (text/csv, UTF-8 with a byte-order mark), newest judged first: the company's own facts only, no lead's address or phone",
    query: foundFilterQuery,
  })
  async export(
    @Query() query: FoundFilterQuery,
    @Req() req: OwnRunsRequest,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const { tenant } = req;
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (tenant === undefined) throw new Error("no tenant on an own-runs route");
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${FOUND_CSV_NAME}-${day}.csv"`);
    res.setHeader("cache-control", "no-store");
    const inRun = <T>(fn: () => Promise<T>) => withTenant(tenant, fn, { client: givenClient() });
    try {
      await pipeline(foundCompaniesCsv(query, inRun), res);
    } catch (error) {
      // The client left: nothing to answer. Anything else is the error filter's.
      if ((error as { code?: unknown }).code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
    }
  }

  @Post(":id/not-fit")
  @HttpCode(200)
  @SetMetadata("whytide:permission", permissions["signals.write"])
  @SetMetadata("whytide:api-route", {
    summary:
      "Marks a found company Not a fit: it moves to not_fit as the member's, with who and when, and its source never reads or judges it again, whatever its age; one marked already stays as it was; its source's creator or a holder of signals.manage only (a company whose source is gone, signals.manage alone)",
    params: foundParams,
    response: foundCompanyResponse,
    errors: [errors.signal_found_company_not_found],
  })
  async notFit(@Param("id") id: string): Promise<FoundCompanyResponse> {
    return toResponse(await markNotFit(id));
  }
}

function toResponse(company: FoundCompany): FoundCompanyResponse {
  return {
    ...company,
    markedAt: company.markedAt?.toISOString() ?? null,
    reasons: company.reasons.map((reason) => ({ ...reason })),
    phones: [...company.phones],
    leads: company.leads.map((lead) => ({ ...lead })),
    judgedAt: company.judgedAt.toISOString(),
  };
}

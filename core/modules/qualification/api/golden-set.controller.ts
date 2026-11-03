// GET …/qualification/exports/golden-set.jsonl (README.md "The golden set"), under contacts'
// exports.read: the golden set written under the workspace's exports/, then answered. The route opens
// its own runs (whytide:own-runs), so that the files port is called outside any.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Controller, Get, Query, Req, Res, SetMetadata } from "@nestjs/common";
import { errors as contactsErrors, permissions } from "@whytide/contacts";
import type { TenantContext } from "@whytide/platform";
import { filesPort } from "@whytide/providers";
import { exportGoldenSet, JSONL } from "../domain/export/golden-set.ts";
import { type GoldenSetQuery, goldenSetQuery } from "../schemas/exports.ts";

/** The request of a whytide:own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

@Controller("exports")
export class GoldenSetController {
  @Get("golden-set.jsonl")
  @SetMetadata("whytide:permission", permissions["exports.read"])
  @SetMetadata("whytide:own-runs", true)
  @SetMetadata("whytide:api-route", {
    summary:
      "The golden set, a JSON line per reviewed lead without names (application/jsonl), also written under the workspace's exports/",
    query: goldenSetQuery,
    errors: [contactsErrors.contacts_input_invalid, filesPort.errors.files_too_large],
  })
  async goldenSet(
    @Query() query: GoldenSetQuery,
    @Req() req: OwnRunsRequest,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const { tenant } = req;
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (tenant === undefined) throw new Error("no tenant on an own-runs route");
    const { key, body } = await exportGoldenSet(tenant, query);
    res.setHeader("content-type", JSONL);
    res.setHeader("content-disposition", `attachment; filename="${key.split("/").at(-1)}"`);
    res.setHeader("cache-control", "no-store");
    res.end(body);
  }
}

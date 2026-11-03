// GET …/inbox/exports/reply-labels.jsonl (README.md "The reply golden set"), under inbox.read: the
// reply golden set written under the workspace's exports/, then answered as JSON Lines. The route
// opens its own runs (whytide:own-runs), so that the files port is called outside any. It reads
// inbox's tables and contacts' getLead, and calls no provider but the files port: nothing here sends.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Controller, Get, Query, Req, Res, SetMetadata } from "@nestjs/common";
import type { TenantContext } from "@whytide/platform";
import { filesPort } from "@whytide/providers";
import { JSONL } from "../domain/export/constants.ts";
import { exportReplyLabels } from "../domain/export/reply-labels.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import { type ReplyLabelsQuery, replyLabelsQuery } from "../schemas/exports.ts";

/** The request of a whytide:own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

@Controller("exports")
export class ExportsController {
  @Get("reply-labels.jsonl")
  @SetMetadata("whytide:permission", permissions["inbox.read"])
  @SetMetadata("whytide:own-runs", true)
  @SetMetadata("whytide:api-route", {
    summary:
      "The reply golden set, a JSON line per labeled reply with the conversation before it, the person's names masked and no id (application/jsonl), also written under the workspace's exports/",
    query: replyLabelsQuery,
    errors: [errors.week_invalid, filesPort.errors.files_too_large],
  })
  async replyLabels(
    @Query() query: ReplyLabelsQuery,
    @Req() req: OwnRunsRequest,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const { tenant } = req;
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (tenant === undefined) throw new Error("no tenant on an own-runs route");
    const { key, body } = await exportReplyLabels(tenant, query);
    res.setHeader("content-type", JSONL);
    res.setHeader("content-disposition", `attachment; filename="${key.split("/").at(-1)}"`);
    res.setHeader("cache-control", "no-store");
    res.end(body);
  }
}

// GET …/inbox/exports/reply-labels.jsonl (README.md "The reply golden set"), under inbox.export, an
// Owner's or an Admin's, a Member refused forbidden (gamma-p7-060): the reply golden set of the
// caller's own threads (gamma-p6-060), written under the workspace's exports/, then answered as JSON
// Lines. The route opens its own runs (whytide:own-runs), so that the files port is called outside
// any. It reads inbox's tables and contacts' getLead, and calls no provider but the files port:
// nothing here sends.
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
  @SetMetadata("whytide:permission", permissions["inbox.export"])
  @SetMetadata("whytide:own-runs", true)
  @SetMetadata("whytide:api-route", {
    summary:
      "The reply golden set of the caller's own threads, Owner or Admin only, a JSON line per labeled reply with its channel, the owner's class, the classification and the conversation before it, the person's names masked and no id (application/jsonl), also written under the workspace's exports/",
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
    // The caller's own threads only: a member reads no other member's replies (gamma-p6-060).
    const view = { ...query, owner: tenant.principal.userId };
    const { key, body } = await exportReplyLabels(tenant, view);
    res.setHeader("content-type", JSONL);
    res.setHeader("content-disposition", `attachment; filename="${key.split("/").at(-1)}"`);
    res.setHeader("cache-control", "no-store");
    res.end(body);
  }
}

// POST …/contacts/exclusions/imports, GET …/contacts/exclusions/lists and DELETE
// …/contacts/exclusions/lists/{listId} (gamma-p2-045; README.md "Routes"): an exclusion list from a
// CSV, the lists, and a list removed. The upload declares whytide:own-runs, as discovery's does: it
// reads the client's file to its end outside any run, checked as it arrives (api/multipart.ts,
// domain/exclusions/csv.ts), then imports it in one run of the request's workspace, all or nothing.
// The file is not stored. The GET runs in the request's run. The DELETE declares whytide:own-runs too
// (review-gaps): its run waits for an import of the workspace to end, which may take longer than a
// request's run, then removes the list in it (REMOVAL_RUN_TIMEOUT_MS). Every role imports and
// reads (suppression.write, suppression.read); a removal lifts exclusions, so it is
// suppression.remove, the Owner's and the Admin's (permissions.ts). ExportsController ends the
// module's own client at shutdown.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  SetMetadata,
} from "@nestjs/common";
import type { TenantContext } from "@whytide/platform";
import {
  BODY_LIMIT_FACTOR,
  IMPORT_RUN_TIMEOUT_MS,
  REMOVAL_RUN_TIMEOUT_MS,
} from "../domain/exclusions/constants.ts";
import { readExclusionFile } from "../domain/exclusions/csv.ts";
import {
  type ExclusionList,
  importExclusionList,
  listExclusionLists,
  removeExclusionList,
} from "../domain/exclusions/lists.ts";
import { inRun } from "../domain/store.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type ExclusionImportQuery,
  type ExclusionImportResponse,
  type ExclusionListPage,
  type ExclusionListQuery,
  type ExclusionListResponse,
  exclusionImport,
  exclusionImportQuery,
  exclusionListPage,
  exclusionListParams,
  exclusionListQuery,
} from "../schemas/exclusions.ts";
import { exclusionSettings } from "../settings.ts";
import { receiveFile } from "./multipart.ts";

/** The request of a whytide:own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

const LIMITS = {
  maxBytes: exclusionSettings.EXCLUSIONS_IMPORT_MAX_BYTES,
  maxRows: exclusionSettings.EXCLUSIONS_IMPORT_MAX_ROWS,
};
/** The body a request may carry: twice the file's limit, so a file a little over it is told so. */
const BODY_LIMIT = BODY_LIMIT_FACTOR * LIMITS.maxBytes;
const UPLOAD = { fileBytes: LIMITS.maxBytes, bodyBytes: BODY_LIMIT };

const read = SetMetadata("whytide:permission", permissions["suppression.read"]);
const write = SetMetadata("whytide:permission", permissions["suppression.write"]);
const remove = SetMetadata("whytide:permission", permissions["suppression.remove"]);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);

@Controller("exclusions")
export class ExclusionsController {
  @Post("imports")
  @write
  @SetMetadata("whytide:multipart", true)
  @SetMetadata("whytide:body-limit", BODY_LIMIT)
  @SetMetadata("whytide:own-runs", true)
  @route({
    summary:
      "Imports a CSV of company domains (multipart/form-data, one file part named *.csv, a `domain` column) as one exclusion list of customers or competitors: each domain a relationship entry on every channel, the leads at it or a subdomain suppressed, all in one run; the file is not stored",
    query: exclusionImportQuery,
    response: exclusionImport,
    errors: [
      errors.exclusions_unsupported_type,
      errors.exclusions_bad_encoding,
      errors.exclusions_missing_column,
      errors.exclusions_too_many_rows,
      errors.exclusions_too_large,
      errors.exclusions_no_valid_row,
    ],
  })
  async upload(
    @Query() query: ExclusionImportQuery,
    @Req() req: OwnRunsRequest,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<ExclusionImportResponse> {
    const { tenant } = req;
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (tenant === undefined) throw new Error("no tenant on an own-runs route");
    try {
      const { name, file } = await receiveFile(req, UPLOAD, async ({ name, stream }) => ({
        name,
        file: await readExclusionFile(stream, LIMITS),
      }));
      const input = { name, relationship: query.relationship, file };
      const answer = await inRun(
        tenant,
        () => importExclusionList({ ...input, createdBy: tenant.principal.userId }),
        { timeout: IMPORT_RUN_TIMEOUT_MS },
      );
      return { ...answer, list: toList(answer.list), invalid: [...answer.invalid] };
    } catch (error) {
      // A refusal before the body's end leaves the rest unread: the connection closes with the answer.
      if (!req.readableEnded && !res.headersSent) res.setHeader("connection", "close");
      throw error;
    }
  }

  @Get("lists")
  @read
  @route({
    summary:
      "The workspace's exclusion lists, newest first, a page at a time, the removed ones with their removal",
    query: exclusionListQuery,
    response: exclusionListPage,
  })
  async lists(@Query() query: ExclusionListQuery): Promise<ExclusionListPage> {
    const { lists, nextCursor } = await listExclusionLists(query);
    return { lists: lists.map(toList), nextCursor };
  }

  @Delete("lists/:listId")
  @HttpCode(204)
  @remove
  @SetMetadata("whytide:own-runs", true)
  @route({
    summary:
      "Removes an exclusion list as a whole: the list and its active entries stay on record with their removal",
    params: exclusionListParams,
    errors: [errors.exclusion_list_not_found],
  })
  async remove(@Param("listId") listId: string, @Req() req: OwnRunsRequest): Promise<void> {
    const { tenant } = req;
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (tenant === undefined) throw new Error("no tenant on an own-runs route");
    const removedBy = tenant.principal.userId;
    await inRun(tenant, () => removeExclusionList(listId, { removedBy }), {
      timeout: REMOVAL_RUN_TIMEOUT_MS,
    });
  }
}

/** A list as the routes answer it: no workspace, the times as ISO strings. */
function toList(list: ExclusionList): ExclusionListResponse {
  const { id, name, relationship, entryCount, duplicateCount, invalidCount, createdBy } = list;
  const createdAt = list.createdAt.toISOString();
  const removedAt = list.removedAt?.toISOString() ?? null;
  const { removedBy } = list;
  const counts = { entryCount, duplicateCount, invalidCount };
  return { id, name, relationship, ...counts, createdBy, createdAt, removedAt, removedBy };
}

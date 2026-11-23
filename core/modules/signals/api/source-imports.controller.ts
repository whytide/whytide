// The source imports routes (README.md "Importing sources"; sources-csv-import), under
// /v1/workspaces/:workspaceId/signals/sources/imports: the check of a CSV file of sources, its import,
// and the workspace's imports. The check and the import declare whytide:own-runs, as the create
// does: a post's short link is resolved outside any run, and each database step opens its own
// (domain/import/imports.ts). They take the sources' write permission, the list the read one.
import type { IncomingMessage } from "node:http";
import { Body, Controller, Get, HttpCode, Post, Req, SetMetadata } from "@nestjs/common";
import type { TenantContext } from "@whytide/platform";
import { SOURCE_IMPORT_BODY_BYTES } from "../domain/import/constants.ts";
import {
  checkSources,
  importSources,
  listSourceImports,
  type SourceFile,
  type SourceImport,
} from "../domain/import/imports.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type SourceImportBody,
  type SourceImportCheckResponse,
  type SourceImportResponse,
  type SourceImportResultResponse,
  sourceImportBody,
  sourceImportCheckResponse,
  sourceImportListResponse,
  sourceImportResultResponse,
} from "../schemas/source-imports.ts";

const read = SetMetadata("whytide:permission", permissions["signals.read"]);
const write = SetMetadata("whytide:permission", permissions["signals.write"]);
const ownRuns = SetMetadata("whytide:own-runs", true);
const bodyLimit = SetMetadata("whytide:body-limit", SOURCE_IMPORT_BODY_BYTES);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);
/** The request of an own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

/** The file's refusals, the check's and the import's alike. */
const FILE_ERRORS = [
  errors.signal_import_unsupported_type,
  errors.signal_import_too_large,
  errors.signal_import_too_many_rows,
  errors.signal_import_missing_column,
  errors.signal_import_bad_encoding,
  errors.signal_sender_account_invalid,
];

@Controller("sources/imports")
export class SourceImportsController {
  @Post("check")
  @HttpCode(200)
  @write
  @ownRuns
  @bodyLimit
  @route({
    summary:
      "Checks a CSV file of sources, its bytes in base64, row by row as a create would, creating nothing: the valid rows and each row's error",
    body: sourceImportBody,
    response: sourceImportCheckResponse,
    errors: FILE_ERRORS,
  })
  async check(
    @Req() req: OwnRunsRequest,
    @Body() body: SourceImportBody,
  ): Promise<SourceImportCheckResponse> {
    const checked = await checkSources(tenantOf(req), fileOf(body));
    const valid = checked.valid.map(({ row, kind, label }) => ({ row, kind, label }));
    return { fileName: body.fileName, rows: checked.rows, valid, errors: [...checked.errors] };
  }

  @Post()
  @write
  @ownRuns
  @bodyLimit
  @route({
    summary:
      "Imports a CSV file of sources: checks it again, creates each valid row in the file's order, disabled past the limits of enabled sources, and records the import; 201 with the import and every row not imported",
    body: sourceImportBody,
    response: sourceImportResultResponse,
    errors: FILE_ERRORS,
  })
  async create(
    @Req() req: OwnRunsRequest,
    @Body() body: SourceImportBody,
  ): Promise<SourceImportResultResponse> {
    const { sourceImport, errors: refused } = await importSources(tenantOf(req), fileOf(body));
    return { sourceImport: toSourceImport(sourceImport), errors: refused };
  }

  @Get()
  @read
  @route({
    summary: "The workspace's source imports, the newest first, 100 at most",
    response: sourceImportListResponse,
  })
  async list(): Promise<{ imports: SourceImportResponse[] }> {
    return { imports: (await listSourceImports()).map(toSourceImport) };
  }
}

/** The host sets it on an own-runs route: a missing one is a host bug, 500. */
function tenantOf(req: OwnRunsRequest): TenantContext {
  if (req.tenant === undefined) throw new Error("no tenant on an own-runs route");
  return req.tenant;
}

const fileOf = (body: SourceImportBody): SourceFile => ({
  name: body.fileName,
  bytes: Buffer.from(body.file, "base64"),
  senderAccountId: body.senderAccountId,
});

function toSourceImport(found: SourceImport): SourceImportResponse {
  const { id, fileName, createdBy, createdAt } = found;
  const counts = {
    created: found.createdCount,
    disabled: found.disabledCount,
    refused: found.refusedCount,
  };
  return { id, fileName, createdBy, createdAt: createdAt.toISOString(), ...counts };
}

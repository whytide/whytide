// The imports routes (README.md "Routes"), which the api host mounts under
// /v1/workspaces/:workspaceId/discovery. A module cannot import the host: each route writes the host's
// metadata keys with SetMetadata (core/apps/api/README.md "Modules"). The GET routes and the run run
// in the request's tenant run; the upload declares whytide:own-runs and opens its own (api/upload.ts).
// The run claims the job and hands it to the worker (domain/import/run.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  Controller,
  Get,
  HttpCode,
  Module,
  type OnApplicationShutdown,
  Param,
  Post,
  Req,
  Res,
  SetMetadata,
} from "@nestjs/common";
import { AppError, type TenantContext } from "@whytide/platform";
import { requestImportRun } from "../domain/import/run.ts";
import { findImportJob, type ImportJob, listImportJobs } from "../domain/jobs.ts";
import { disconnectClient } from "../domain/store.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type ImportJobListResponse,
  type ImportJobResponse,
  importJobListResponse,
  importJobParams,
  importJobResponse,
} from "../schemas/imports.ts";
import { BODY_LIMIT, uploadImport } from "./upload.ts";

/** The request of a whytide:own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

@Controller("imports")
export class ImportsController {
  @Post()
  @SetMetadata("whytide:permission", permissions["imports.write"])
  @SetMetadata("whytide:multipart", true)
  @SetMetadata("whytide:body-limit", BODY_LIMIT)
  @SetMetadata("whytide:own-runs", true)
  @SetMetadata("whytide:api-route", {
    summary:
      "Uploads a CSV of LinkedIn profile URLs (multipart/form-data, one file part) and validates it",
    response: importJobResponse,
    errors: [
      errors.import_unsupported_type,
      errors.import_too_large,
      errors.import_too_many_rows,
      errors.import_missing_column,
      errors.import_bad_encoding,
    ],
  })
  async upload(
    @Req() req: OwnRunsRequest,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<ImportJobResponse> {
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (req.tenant === undefined) throw new Error("no tenant on an own-runs route");
    try {
      return view(await uploadImport(req, req.tenant));
    } catch (error) {
      // A refusal before the body's end leaves the rest unread: the connection closes with the answer.
      if (!req.readableEnded && !res.headersSent) res.setHeader("connection", "close");
      throw error;
    }
  }

  @Get()
  @SetMetadata("whytide:permission", permissions["imports.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The workspace's imports, the newest first, 100 at most",
    response: importJobListResponse,
  })
  async list(): Promise<ImportJobListResponse> {
    return { jobs: (await listImportJobs()).map(view) };
  }

  @Get(":job")
  @SetMetadata("whytide:permission", permissions["imports.read"])
  @SetMetadata("whytide:api-route", {
    summary: "One import with its validation report",
    params: importJobParams,
    response: importJobResponse,
    errors: [errors.import_not_found],
  })
  async get(@Param("job") id: string): Promise<ImportJobResponse> {
    const job = await findImportJob(id);
    if (job === null) throw new AppError(errors.import_not_found);
    return view(job);
  }

  // Idempotent through the job, not an Idempotency-Key: a second run finds the job claimed and
  // answers import_not_runnable.
  @Post(":job/run")
  @HttpCode(202)
  @SetMetadata("whytide:permission", permissions["imports.write"])
  @SetMetadata("whytide:api-route", {
    summary:
      "Starts a validated import's run in the worker, once: answers the job, running; GET …/imports/{job} gives its counts",
    params: importJobParams,
    response: importJobResponse,
    errors: [errors.import_not_found, errors.import_not_runnable],
  })
  async run(@Param("job") id: string): Promise<ImportJobResponse> {
    return view(await requestImportRun(id));
  }
}

function view(job: ImportJob): ImportJobResponse {
  const { id, fileName, status, rowCount, validCount, errorCount, report, counts, failure } = job;
  return {
    id,
    fileName,
    status,
    rowCount,
    validCount,
    errorCount,
    errors: report.map(({ row, code }) => ({ row, code })),
    counts,
    failure,
    createdBy: job.createdBy,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

@Module({ controllers: [ImportsController] })
export class DiscoveryApi implements OnApplicationShutdown {
  /** Once the api's server has closed and its requests have ended, the module's own client ends. */
  async onApplicationShutdown(): Promise<void> {
    await disconnectClient();
  }
}

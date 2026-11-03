// The sources routes (README.md "API"), which the api host mounts under
// /v1/workspaces/:workspaceId/signals: thin handlers over domain/sources.ts, inside the request's
// tenant run, but the create: its kind's schema may call out (a short link), which no run waits on,
// so it declares whytide:own-runs and opens its own (core/apps/api/README.md "Request protection").
// A module cannot import the host, so each route sets the host's metadata itself: its permission and
// its @ApiRoute (core/apps/api/README.md "Permissions", "OpenAPI and the client").
import type { IncomingMessage } from "node:http";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  Patch,
  Post,
  Req,
  SetMetadata,
} from "@nestjs/common";
import type { TenantContext } from "@whytide/platform";
import { fireTimes } from "../domain/fire-times.ts";
import {
  addSource,
  deleteSource,
  type ListedSource,
  listRuns,
  listSources,
  requestRun,
  type SignalRun,
  stopRun,
  updateSource,
} from "../domain/sources.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type CreateSourceBody,
  createSourceBody,
  type RunResponse,
  runListResponse,
  runParams,
  runResponse,
  type SourceResponse,
  sourceListResponse,
  sourceParams,
  sourceResponse,
  type UpdateSourceBody,
  updateSourceBody,
} from "../schemas/sources.ts";
import { EvidenceController } from "./evidence.controller.ts";

const read = SetMetadata("whytide:permission", permissions["signals.read"]);
const write = SetMetadata("whytide:permission", permissions["signals.write"]);
const runs = SetMetadata("whytide:permission", permissions["signals.run"]);
const idempotent = SetMetadata("whytide:idempotent", true);
const ownRuns = SetMetadata("whytide:own-runs", true);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);
/** The request of an own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

@Controller("sources")
export class SourcesController {
  @Post()
  @write
  @ownRuns
  @route({
    summary: "Creates a source of a registered kind, enabled; publishes signals.source_created",
    body: createSourceBody,
    response: sourceResponse,
    errors: [
      errors.signal_kind_unknown,
      errors.signal_config_invalid,
      errors.signal_post_link_unreachable,
      errors.signal_sender_account_invalid,
      errors.signal_sources_limit,
    ],
  })
  async create(
    @Req() req: OwnRunsRequest,
    @Body() body: CreateSourceBody,
  ): Promise<SourceResponse> {
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (req.tenant === undefined) throw new Error("no tenant on an own-runs route");
    return toSource(await addSource(req.tenant, body));
  }

  @Get()
  @read
  @route({
    summary:
      "The workspace's sources, newest first, each with its next fire times and its open run, running or waiting, or null",
    response: sourceListResponse,
  })
  async list(): Promise<{ sources: SourceResponse[] }> {
    return { sources: (await listSources()).map(toSource) };
  }

  @Patch(":id")
  @write
  @route({
    summary:
      "Enables, disables or relabels a source; enabling one counts against the limit; a change of enabled publishes signals.source_updated",
    params: sourceParams,
    body: updateSourceBody,
    response: sourceResponse,
    errors: [
      errors.signal_source_not_found,
      errors.signal_kind_unknown,
      errors.signal_sources_limit,
    ],
  })
  async update(@Param("id") id: string, @Body() body: UpdateSourceBody): Promise<SourceResponse> {
    return toSource(await updateSource(id, body));
  }

  @Delete(":id")
  @HttpCode(204)
  @write
  @route({
    summary: "Deletes a source and its runs; publishes signals.source_deleted",
    params: sourceParams,
    errors: [errors.signal_source_not_found],
  })
  async remove(@Param("id") id: string): Promise<void> {
    await deleteSource(id);
  }

  @Post(":id/run")
  @HttpCode(202)
  @runs
  @idempotent
  @route({
    summary:
      "Runs a source now: 202 with its run, scheduled; publishes signals.run_requested; 409 while one of its runs is running or waiting",
    params: sourceParams,
    response: runResponse,
    errors: [errors.signal_source_not_found, errors.signal_run_open],
  })
  async run(@Param("id") id: string): Promise<RunResponse> {
    return toRun(await requestRun(id));
  }

  @Post(":id/runs/:runId/stop")
  @HttpCode(202)
  @runs
  @idempotent
  @route({
    summary:
      "Stops a run of the source that has not ended: 202 with the run and when its stop was asked; publishes signals.run_stop_requested, on which the worker cancels its workflow; 409 once it ended",
    params: runParams,
    response: runResponse,
    errors: [errors.signal_source_not_found, errors.signal_run_not_open],
  })
  async stop(@Param("id") id: string, @Param("runId") runId: string): Promise<RunResponse> {
    return toRun(await stopRun(id, runId));
  }

  @Get(":id/runs")
  @read
  @route({
    summary: "A source's runs, newest first: those not started yet, then by their start",
    params: sourceParams,
    response: runListResponse,
    errors: [errors.signal_source_not_found],
  })
  async runs(@Param("id") id: string): Promise<{ runs: RunResponse[] }> {
    return { runs: (await listRuns(id)).map(toRun) };
  }
}

@Module({ controllers: [SourcesController, EvidenceController] })
export class SignalsApi {}

/**
 * A source as the API answers it: the row without the workspace and the reader's watermark, with its
 * next fire times (domain/fire-times.ts), whether a run of it is open, and that run.
 */
function toSource(source: ListedSource): SourceResponse {
  const { id, kind, label, senderAccountId, enabled, createdBy, createdAt, lastRunAt } = source;
  const config = source.config as SourceResponse["config"];
  const times = { createdAt: createdAt.toISOString(), lastRunAt: lastRunAt?.toISOString() ?? null };
  const fire = fireTimes(source);
  const open = source.openRun;
  const schedule = {
    fireTimes: fire.fireTimes.map((at) => at.toISOString()),
    nextRunAt: fire.nextRunAt?.toISOString() ?? null,
    runOpen: open !== null,
    openRun: open && { ...open, stopRequestedAt: open.stopRequestedAt?.toISOString() ?? null },
  };
  return { id, kind, config, label, senderAccountId, enabled, createdBy, ...times, ...schedule };
}

function toRun(run: SignalRun): RunResponse {
  const { id, sourceId, status, startedAt, finishedAt, error } = run;
  const counts = run.counts as RunResponse["counts"];
  const times = {
    startedAt: startedAt?.toISOString() ?? null,
    finishedAt: finishedAt?.toISOString() ?? null,
    stopRequestedAt: run.stopRequestedAt?.toISOString() ?? null,
  };
  return { id, sourceId, status, ...times, counts, error };
}

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
import { agentsBySource, type SourceAgent } from "../domain/agents.ts";
import { fireTimes } from "../domain/fire-times.ts";
import { importFilesOf } from "../domain/import/imports.ts";
import { lastPlanOf } from "../domain/research/last.ts";
import { cadenceOf, lastRunsAtBudget } from "../domain/schedule/daily.ts";
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
  type ResearchPlanResponse,
  type RunResponse,
  researchPlanResponse,
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
import { settings } from "../settings.ts";
import { EvidenceController } from "./evidence.controller.ts";
import { FoundCompaniesController } from "./found-companies.controller.ts";
import { SourceImportsController } from "./source-imports.controller.ts";

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
    summary:
      "Creates a source of a registered kind, enabled; publishes signals.source_created; a kind that reads through a LinkedIn account needs senderAccountId, web_research takes none",
    body: createSourceBody,
    response: sourceResponse,
    errors: [
      errors.signal_kind_unknown,
      errors.signal_config_invalid,
      errors.signal_topic_blocked,
      errors.signal_post_link_unreachable,
      errors.signal_sender_account_invalid,
      errors.signal_sources_limit,
      errors.signal_tracked_limit,
    ],
  })
  async create(
    @Req() req: OwnRunsRequest,
    @Body() body: CreateSourceBody,
  ): Promise<SourceResponse> {
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (req.tenant === undefined) throw new Error("no tenant on an own-runs route");
    // A new source has no run yet, no agent, and the form's comes from no import.
    return toSource(await addSource(req.tenant, body), false, new Map(), new Map());
  }

  @Get()
  @read
  @route({
    summary:
      "The workspace's sources, newest first, each with its next fire times, its open run, running or waiting, or null, its cadence, whether its last run ended at its read budget, and its agent or null",
    response: sourceListResponse,
  })
  async list(): Promise<{ sources: SourceResponse[] }> {
    const sources = await listSources();
    const atBudget = await lastRunsAtBudget(sources);
    const files = await importFilesOf(sources);
    const agents = await agentsBySource();
    const listed = sources.map((source) =>
      toSource(source, atBudget.has(source.id), files, agents),
    );
    return { sources: listed };
  }

  @Patch(":id")
  @write
  @route({
    summary:
      "Enables, disables or relabels a source, or changes the config of a kind that allows it (web_research; any other kind's is signal_config_invalid); enabling one counts against its group's limit, its agent's or that of the sources in no agent, and reads its config again; a change of enabled publishes signals.source_updated",
    params: sourceParams,
    body: updateSourceBody,
    response: sourceResponse,
    errors: [
      errors.signal_source_not_found,
      errors.signal_kind_unknown,
      errors.signal_config_invalid,
      errors.signal_sources_limit,
      errors.signal_tracked_limit,
    ],
  })
  async update(@Param("id") id: string, @Body() body: UpdateSourceBody): Promise<SourceResponse> {
    const source = await updateSource(id, body);
    const atBudget = (await lastRunsAtBudget([source])).has(source.id);
    return toSource(source, atBudget, await importFilesOf([source]), await agentsBySource());
  }

  @Delete(":id")
  @HttpCode(204)
  @write
  @route({
    summary: "Deletes a source, its runs and its agent's link; publishes signals.source_deleted",
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
      "Runs a source now: 202 with its run, scheduled; publishes signals.run_requested; 409 while one of its runs is running or waiting, while its agent is paused, or once a post engagers source's lookback after its save has passed",
    params: sourceParams,
    response: runResponse,
    errors: [
      errors.signal_source_not_found,
      errors.signal_run_open,
      errors.signal_source_expired,
      errors.signal_agent_paused,
    ],
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

  @Get(":id/research-plan")
  @read
  @route({
    summary:
      "The last plan of a Web research source (gamma-wr-041): its words by language, its source types' ids and when it was made; plan null before the first run's plan",
    params: sourceParams,
    response: researchPlanResponse,
    errors: [errors.signal_source_not_found],
  })
  async researchPlan(@Param("id") id: string): Promise<ResearchPlanResponse> {
    const plan = await lastPlanOf(id);
    if (plan === null) return { plan };
    const words = plan.words.map(({ language, words }) => ({ language, words: [...words] }));
    return {
      plan: { ...plan, words, placeIds: [...plan.placeIds], madeAt: plan.madeAt.toISOString() },
    };
  }
}

// The imports' first: their paths are under sources/, beside a source's own.
@Module({
  controllers: [
    SourceImportsController,
    SourcesController,
    EvidenceController,
    FoundCompaniesController,
  ],
})
export class SignalsApi {}

/**
 * A source as the API answers it: the row without the workspace and the reader's watermark, with its
 * next fire times (domain/fire-times.ts), whether a run of it is open, and that run; its kind's
 * cadence, whether its last run ended at its read budget (`atBudget`), the import it came from, its
 * file named from `files` (sources-csv-import), and its agent from `agents` (gamma-p5-045).
 */
function toSource(
  source: ListedSource,
  atBudget: boolean,
  files: ReadonlyMap<string, string>,
  agents: ReadonlyMap<string, SourceAgent>,
): SourceResponse {
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
  const cadence = cadenceOf(kind);
  const everyDays = cadence === "research" ? settings.SIGNALS_RESEARCH_EVERY_DAYS : null;
  const daily = { cadence, everyDays, lastRunBudgetReached: atBudget };
  const fileName = source.importId === null ? undefined : files.get(source.importId);
  const sourceImport = source.importId && fileName ? { id: source.importId, fileName } : null;
  return {
    id,
    kind,
    config,
    label,
    senderAccountId,
    enabled,
    createdBy,
    ...times,
    ...schedule,
    ...daily,
    sourceImport,
    playbook: agents.get(id) ?? null,
  };
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

// signals' commands and queries on sources and their runs (README.md "API"), for the api's handlers:
// each runs inside the request's tenant run, on its transaction (tenantClient), so every query is
// scoped to the workspace currentTenant() names (core/packages/db README). A write checks its kind
// against the registry, and a create its config against the kind's schema and its sender account
// against linkedin's; the create route reads the config outside any run first (addSource).
import { outboxWriter, type Prisma, tenantClient, withTenant } from "@whytide/db";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import {
  AppError,
  currentTenant,
  isAppError,
  newId,
  publish,
  type TenantContext,
} from "@whytide/platform";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import { settings } from "../settings.ts";
import { parseSourceConfig, sourceKind } from "../sources/registry.ts";
import { givenClient } from "./client.ts";
import { ENDED, runNowWorkflowIdOf } from "./constants.ts";

export type SignalSource = {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly config: unknown;
  readonly label: string;
  readonly senderAccountId: string;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly lastRunAt: Date | null;
  readonly watermark: unknown;
};
export type SignalRunStatus = "scheduled" | "running" | "waiting" | "done" | "failed" | "cancelled";
export type SignalRun = {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly status: SignalRunStatus;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly counts: unknown;
  readonly error: string | null;
  /** Its workflow's id, recorded at its start (fix-run-stop). */
  readonly workflowId: string | null;
  readonly stopRequestedAt: Date | null;
};
/** A source's open run: why run now is refused, which the screen says in words, and its stop. */
export type OpenRun = {
  readonly id: string;
  readonly status: "running" | "waiting";
  readonly stopRequestedAt: Date | null;
};
/** A source as the api answers it: with its open run, `running` or `waiting`, or null. */
export type ListedSource = SignalSource & { readonly openRun: OpenRun | null };
export type NewSource = {
  readonly kind: string;
  readonly config: unknown;
  readonly label: string;
  readonly senderAccountId: string;
};

/** A run in these states is open: run now answers signal_run_open until it ends. */
const OPEN: SignalRunStatus[] = ["running", "waiting"];

/**
 * The create route's (whytide:own-runs): the config read by its kind's schema outside any run, since
 * the schema may call out (post_engagers resolves a short link) and a run waits on none
 * (core/packages/db README "One run at a time"); then createSource in a run of its own, which reads
 * that config again, canonical, with no call.
 */
export async function addSource(tenant: TenantContext, input: NewSource): Promise<ListedSource> {
  const config = await parseSourceConfig(sourceKind(input.kind), input.config);
  return withTenant(tenant, () => createSource({ ...input, config }), { client: givenClient() });
}

/**
 * A source of a registered kind, enabled, created by the principal, on a sender account of the
 * workspace, connected or not (a disconnected one blocks its runs); publishes signals.source_created.
 */
export async function createSource(input: NewSource): Promise<ListedSource> {
  const kind = sourceKind(input.kind);
  const config = (await parseSourceConfig(kind, input.config)) as Prisma.InputJsonValue;
  await assertSenderAccount(input.senderAccountId);
  const { workspaceId, principal } = currentTenant();
  await lockEnabledSources(workspaceId);
  await assertRoomForOneMore();
  const source = await tenantClient.signalSource.create({
    data: {
      id: newId(ids.signal_source),
      workspaceId,
      kind: kind.kind,
      config,
      label: input.label,
      senderAccountId: input.senderAccountId,
      createdBy: principal.userId,
    },
  });
  const created = { source_id: source.id };
  await publish(outboxWriter(tenantClient, workspaceId), events["signals.source_created"], created);
  return { ...source, openRun: null };
}

/** The workspace's sources, newest first. */
export async function listSources(): Promise<ListedSource[]> {
  const sources = await tenantClient.signalSource.findMany({ orderBy: { id: "desc" } });
  const open = await openRuns();
  return sources.map((source) => ({ ...source, openRun: open.get(source.id) ?? null }));
}

/**
 * Enables or disables a source, or relabels it; enabling one counts against the limit. A change of
 * `enabled` publishes signals.source_updated, on which the worker pauses or resumes its schedule.
 */
export async function updateSource(
  id: string,
  patch: { readonly enabled?: boolean; readonly label?: string },
): Promise<ListedSource> {
  // Locked before the source is read: two enables at once count one after the other.
  if (patch.enabled === true) await lockEnabledSources(currentTenant().workspaceId);
  const source = await findSource(id);
  sourceKind(source.kind);
  if (patch.enabled === true && !source.enabled) await assertRoomForOneMore();
  const updated = await tenantClient.signalSource.update({ where: { id: source.id }, data: patch });
  if (patch.enabled !== undefined && patch.enabled !== source.enabled) {
    const outbox = outboxWriter(tenantClient, source.workspaceId);
    await publish(outbox, events["signals.source_updated"], { source_id: source.id });
  }
  return { ...updated, openRun: (await openRuns(source.id)).get(source.id) ?? null };
}

/**
 * Deletes a source and its runs; publishes signals.source_deleted with its open runs' workflow ids,
 * read first, as the delete takes the rows: the worker cancels them (fix-run-stop).
 */
export async function deleteSource(id: string): Promise<void> {
  const source = await findSource(id);
  const open = await tenantClient.signalRun.findMany({
    where: { sourceId: source.id, status: { in: OPEN } },
    select: { id: true, workflowId: true },
  });
  const workflowIds = open.map(
    (run) => run.workflowId ?? runNowWorkflowIdOf(source.workspaceId, run.id),
  );
  await tenantClient.signalSource.delete({ where: { id: source.id } });
  const deleted = {
    source_id: source.id,
    ...(workflowIds.length > 0 ? { workflow_ids: workflowIds } : {}),
  };
  await publish(
    outboxWriter(tenantClient, source.workspaceId),
    events["signals.source_deleted"],
    deleted,
  );
}

/**
 * A run by hand: its row `scheduled`, and signals.run_requested, on which the worker starts it;
 * signal_run_open while one of the source's runs is `running` or `waiting`, which a second run
 * would read the same pages beside.
 */
export async function requestRun(sourceId: string): Promise<SignalRun> {
  const source = await findSource(sourceId);
  if ((await openRuns(source.id)).size > 0) throw new AppError(errors.signal_run_open);
  const { workspaceId } = source;
  const run = await tenantClient.signalRun.create({
    data: { id: newId(ids.signal_run), workspaceId, sourceId: source.id },
  });
  const requested = { source_id: source.id, run_id: run.id };
  await publish(
    outboxWriter(tenantClient, workspaceId),
    events["signals.run_requested"],
    requested,
  );
  return run;
}

/**
 * A stop of a run of the source, not ended yet: its `stop_requested_at` set, the first stop's time
 * kept, and signals.run_stop_requested, on which the worker cancels its workflow; a run not started
 * yet ends at its start (runs.ts startRun). signal_run_not_open once it ended; a run of another
 * source is not found, as its source would be. A second stop publishes again, which is harmless.
 */
export async function stopRun(sourceId: string, runId: string): Promise<SignalRun> {
  const source = await findSource(sourceId);
  // As findSource: an empty id would drop out of the where.
  const where = { id: runId, sourceId: source.id };
  const run = runId ? await tenantClient.signalRun.findFirst({ where }) : null;
  if (run === null) throw new AppError(errors.signal_source_not_found);
  if ((ENDED as readonly string[]).includes(run.status)) {
    throw new AppError(errors.signal_run_not_open);
  }
  const stopRequestedAt = run.stopRequestedAt ?? new Date();
  await tenantClient.signalRun.updateMany({ where: { id: run.id }, data: { stopRequestedAt } });
  const requested = { source_id: source.id, run_id: run.id };
  await publish(
    outboxWriter(tenantClient, source.workspaceId),
    events["signals.run_stop_requested"],
    requested,
  );
  return { ...run, stopRequestedAt };
}

/** A source's runs, newest first: those not started yet, then by their start. */
export async function listRuns(sourceId: string): Promise<SignalRun[]> {
  const source = await findSource(sourceId);
  return tenantClient.signalRun.findMany({
    where: { sourceId: source.id },
    orderBy: [{ startedAt: { sort: "desc", nulls: "first" } }, { id: "desc" }],
  });
}

/**
 * The open run of each source with one, or of the one named, by source id. A scheduled run starts
 * whatever else is open, so a source may have two: a running one is the one shown, else the newest
 * (two waiting ones wait on the same sender account).
 */
async function openRuns(sourceId?: string): Promise<Map<string, OpenRun>> {
  const where = { status: { in: OPEN }, ...(sourceId === undefined ? {} : { sourceId }) };
  const select = { id: true, sourceId: true, status: true, stopRequestedAt: true } as const;
  const runs = await tenantClient.signalRun.findMany({ where, select, orderBy: { id: "asc" } });
  const open = new Map<string, OpenRun>();
  for (const run of runs) {
    // The where keeps the open states only.
    const status = run.status as OpenRun["status"];
    const { id, stopRequestedAt } = run;
    if (open.get(run.sourceId)?.status !== "running")
      open.set(run.sourceId, { id, status, stopRequestedAt });
  }
  return open;
}

/** The source with the id in this workspace, or signal_source_not_found. */
async function findSource(id: string): Promise<SignalSource> {
  // Prisma drops an undefined value from a where: unchecked, that would be any source.
  const found = id ? await tenantClient.signalSource.findFirst({ where: { id } }) : null;
  if (found === null) throw new AppError(errors.signal_source_not_found);
  return found;
}

/** signal_sender_account_invalid unless the account is one of the workspace's. */
async function assertSenderAccount(id: string): Promise<void> {
  try {
    await findSenderAccount(id);
  } catch (error) {
    if (!isAppError(error) || error.code !== linkedinErrors.sender_account_not_found) throw error;
    const details = { fields: ["senderAccountId"] };
    throw new AppError(errors.signal_sender_account_invalid, { details });
  }
}

/**
 * The workspace's lock on its enabled sources, held until the run's transaction ends, so that two
 * writes at once count them one after the other and the limit holds.
 */
async function lockEnabledSources(workspaceId: string): Promise<void> {
  const key = `signals.enabled_sources:${workspaceId}`;
  await tenantClient.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/** signal_sources_limit when SIGNALS_MAX_ENABLED_SOURCES are enabled already. */
async function assertRoomForOneMore(): Promise<void> {
  const limit = settings.SIGNALS_MAX_ENABLED_SOURCES;
  const enabled = await tenantClient.signalSource.count({ where: { enabled: true } });
  if (enabled >= limit) throw new AppError(errors.signal_sources_limit, { details: { limit } });
}

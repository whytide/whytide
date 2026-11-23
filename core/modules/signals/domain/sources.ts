// signals' commands and queries on sources and their runs (README.md "API"), for the api's handlers:
// each runs inside the request's tenant run, on its transaction (tenantClient), so every query is
// scoped to the workspace currentTenant() names (core/packages/db README). A write checks its kind
// against the registry, and a create its config against the kind's schema and its sender account
// against linkedin's; the create route reads the config outside any run first (addSource). The
// enabled limit counts by group, an agent's sources or those in no agent (agents.ts, gamma-p5-045).
// A write of a source, its edit, delete, run and stop, is its creator's or signals.manage's
// (writableSource, gamma-p6-015), and a create or an import reads through the caller's own sender
// account unless signals.manage's (assertSenderAccount). A paused agent's sources read nothing: Run
// now refuses them, and the pause stops their open runs (paused-agent-sources). A kind that reads no
// LinkedIn account (web_research, gamma-wr-030) takes none at its create, its source has none, and its
// config may be edited.
import { outboxWriter, type Prisma, tenantClient, withTenant } from "@whytide/db";
import { findSenderAccount, errors as linkedinErrors, type SenderAccount } from "@whytide/linkedin";
import {
  AppError,
  canWriteOwned,
  currentTenant,
  isAppError,
  newId,
  publish,
  type TenantContext,
} from "@whytide/platform";
import { detachSource } from "@whytide/playbooks";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import { permissions } from "../permissions.ts";
import { settings } from "../settings.ts";
import { isPostsReader, readsThroughAccount, type SourceKind } from "../sources/_contract.ts";
import { parseSourceConfig, registeredSourceKinds, sourceKind } from "../sources/registry.ts";
import { agentStateOf, groupOf, pausedSourcesOf } from "./agents.ts";
import { givenClient } from "./client.ts";
import { ENDED, runNowWorkflowIdOf } from "./constants.ts";

export type SignalSource = {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly config: unknown;
  readonly label: string;
  /** The LinkedIn account it reads through; null for a kind that reads through none. */
  readonly senderAccountId: string | null;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly lastRunAt: Date | null;
  readonly watermark: unknown;
  /** The CSV import that created it (sources-csv-import); null for one added from the form. */
  readonly importId: string | null;
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
  /** Required for a kind that reads through a LinkedIn account, refused for one that does not. */
  readonly senderAccountId?: string | undefined;
  /** The CSV import it comes from, of the workspace (sources-csv-import). */
  readonly importId?: string;
};
/**
 * A create past SIGNALS_MAX_ENABLED_SOURCES in no agent or SIGNALS_MAX_TRACKED_PER_ACCOUNT: refused
 * with the limit's code (the form's), or the source created disabled (a CSV import's,
 * sources-csv-import).
 */
export type OverLimit = "refuse" | "disable";

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
 * A source of a registered kind, enabled, in no agent, created by the principal, on a sender account
 * of the workspace, connected or not (a disconnected one blocks its runs); publishes
 * signals.source_created. Past a limit, refused, or created disabled when `overLimit` says so: its
 * schedule is made paused, as a disabled source's is, and an enable counts it against the limits
 * then.
 */
export async function createSource(
  input: NewSource,
  overLimit: OverLimit = "refuse",
): Promise<ListedSource> {
  const kind = sourceKind(input.kind);
  const config = (await parseSourceConfig(kind, input.config)) as Prisma.InputJsonValue;
  const senderAccountId = await accountOf(kind, input.senderAccountId);
  const { workspaceId, principal } = currentTenant();
  await lockEnabledSources(workspaceId);
  const enabled = await roomForOne(kind, config, senderAccountId, overLimit);
  const source = await tenantClient.signalSource.create({
    data: {
      id: newId(ids.signal_source),
      workspaceId,
      kind: kind.kind,
      config,
      label: input.label,
      senderAccountId,
      enabled,
      createdBy: principal.userId,
      importId: input.importId ?? null,
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
 * Enables or disables a source, or relabels it; enabling one counts against the limits, its sender
 * account's tracked sources first, then its group's enabled sources (its agent's, or those in no
 * agent), and reads its config again by its kind's schema: one the erasure scrubbed is
 * signal_config_invalid. A new `config` is for a kind that allows it, which reads it by its schema and
 * stores the result; for any other kind it is signal_config_invalid naming `config`. A change of
 * `enabled` publishes signals.source_updated, on which the worker
 * pauses or resumes its schedule.
 */
export async function updateSource(
  id: string,
  patch: { readonly enabled?: boolean; readonly label?: string; readonly config?: unknown },
): Promise<ListedSource> {
  // Locked before the source is read: two enables at once count one after the other.
  if (patch.enabled === true) await lockEnabledSources(currentTenant().workspaceId);
  const source = await writableSource(id);
  const kind = sourceKind(source.kind);
  const { config: given, ...fields } = patch;
  let config: Prisma.InputJsonValue | undefined;
  if (given !== undefined) {
    if (kind.configEditable !== true) {
      throw new AppError(errors.signal_config_invalid, { details: { fields: ["config"] } });
    }
    config = (await parseSourceConfig(kind, given)) as Prisma.InputJsonValue;
  }
  if (patch.enabled === true && !source.enabled) {
    const stored = await parseSourceConfig(kind, source.config);
    if (source.senderAccountId !== null && tracks(kind, stored)) {
      await assertRoomForOneTracked(source.senderAccountId);
    }
    await assertRoomForOneMore(source.id);
  }
  const data = { ...fields, ...(config === undefined ? {} : { config }) };
  const updated = await tenantClient.signalSource.update({ where: { id: source.id }, data });
  if (patch.enabled !== undefined && patch.enabled !== source.enabled) {
    const outbox = outboxWriter(tenantClient, source.workspaceId);
    await publish(outbox, events["signals.source_updated"], { source_id: source.id });
  }
  return { ...updated, openRun: (await openRuns(source.id)).get(source.id) ?? null };
}

/**
 * Deletes a source and its runs, and its agent's link through playbooks' detachSource in the same
 * run; publishes signals.source_deleted with its open runs' workflow ids, read first, as the delete
 * takes the rows: the worker cancels them (fix-run-stop).
 */
export async function deleteSource(id: string): Promise<void> {
  const source = await writableSource(id);
  const open = await tenantClient.signalRun.findMany({
    where: { sourceId: source.id, status: { in: OPEN } },
    select: { id: true, workflowId: true },
  });
  const workflowIds = open.map(
    (run) => run.workflowId ?? runNowWorkflowIdOf(source.workspaceId, run.id),
  );
  await tenantClient.signalSource.delete({ where: { id: source.id } });
  await detachSource(source.id);
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
 * would read the same pages beside; signal_source_expired once its kind's runs ended (endsAt);
 * signal_agent_paused while its agent is paused, whatever the reason, as a paused agent's sources
 * read nothing (paused-agent-sources). Each refusal comes before anything is written.
 */
export async function requestRun(sourceId: string, now = new Date()): Promise<SignalRun> {
  const source = await writableSource(sourceId);
  const endsAt = sourceKind(source.kind).endsAt?.(source.createdAt);
  if (endsAt !== undefined && now > endsAt) throw new AppError(errors.signal_source_expired);
  const agent = await agentStateOf(source.id);
  if (agent?.active === false) throw new AppError(errors.signal_agent_paused);
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
  const source = await writableSource(sourceId);
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

/**
 * The open runs of a paused agent's sources stopped as Stop stops them (paused-agent-sources), on
 * playbooks.playbook_updated in the delivery's run: each `running` or `waiting` run whose stop is not
 * asked yet gets its `stop_requested_at` and signals.run_stop_requested, on which the worker cancels
 * it. A run whose stop was asked, by Stop or an earlier delivery, is left as it is, so a redelivery
 * publishes no second stop; an agent active again by the delivery stops nothing; a scheduled run is
 * its start's to end (runs.ts startRun). The count of the runs stopped.
 */
export async function stopPausedAgentRuns(playbookId: string, now = new Date()): Promise<number> {
  const sourceIds = await pausedSourcesOf(playbookId);
  if (sourceIds.length === 0) return 0;
  const unasked = { status: { in: OPEN }, stopRequestedAt: null };
  const runs = await tenantClient.signalRun.findMany({
    where: { sourceId: { in: sourceIds }, ...unasked },
    select: { id: true, sourceId: true },
    orderBy: { id: "asc" },
  });
  const outbox = outboxWriter(tenantClient, currentTenant().workspaceId);
  let stopped = 0;
  for (const run of runs) {
    // Conditioned on the row as it is now: a stop asked meanwhile is not asked again.
    const asked = await tenantClient.signalRun.updateMany({
      where: { id: run.id, ...unasked },
      data: { stopRequestedAt: now },
    });
    if (asked.count === 0) continue;
    const requested = { source_id: run.sourceId, run_id: run.id };
    await publish(outbox, events["signals.run_stop_requested"], requested);
    stopped += 1;
  }
  return stopped;
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

/**
 * The source with the id once the caller may write it (README "Decided here"): its creator, a
 * member, or a holder of signals.manage, through platform's canWriteOwned; anyone else is forbidden,
 * before anything is written. A service's run, the worker's or the erasure's, writes every one.
 */
async function writableSource(id: string): Promise<SignalSource> {
  const source = await findSource(id);
  const owned = { ownerUserId: source.createdBy, manageAction: permissions["signals.manage"] };
  const decision = canWriteOwned(currentTenant().principal, owned);
  if (decision !== "allow") throw new AppError(decision);
  return source;
}

/**
 * The sender account a source of the kind is created with: the one given, checked by assertSenderAccount,
 * for a kind that reads through a LinkedIn account, and none when it is missing, which is
 * signal_sender_account_invalid naming `senderAccountId`; for a kind that reads through none, null,
 * and one given is the same refusal.
 */
async function accountOf(kind: SourceKind, given: string | undefined): Promise<string | null> {
  if (readsThroughAccount(kind) === (given !== undefined)) {
    if (given === undefined) return null;
    await assertSenderAccount(given);
    return given;
  }
  const details = { fields: ["senderAccountId"] };
  throw new AppError(errors.signal_sender_account_invalid, { details });
}

/**
 * signal_sender_account_invalid unless the account is one of the workspace's; then forbidden unless
 * the caller may read through it (README "Decided here"): its owner, a member, or a holder of
 * signals.manage, through platform's canWriteOwned, before anything is written. A service's run
 * reads through every one.
 */
export async function assertSenderAccount(id: string): Promise<void> {
  let account: SenderAccount;
  try {
    account = await findSenderAccount(id);
  } catch (error) {
    if (!isAppError(error) || error.code !== linkedinErrors.sender_account_not_found) throw error;
    const details = { fields: ["senderAccountId"] };
    throw new AppError(errors.signal_sender_account_invalid, { details });
  }
  const owned = { ownerUserId: account.ownerUserId, manageAction: permissions["signals.manage"] };
  const decision = canWriteOwned(currentTenant().principal, owned);
  if (decision !== "allow") throw new AppError(decision);
}

/**
 * The workspace's lock on its enabled sources, held until the run's transaction ends, so that two
 * writes at once count them one after the other and the limit holds.
 */
async function lockEnabledSources(workspaceId: string): Promise<void> {
  const key = `signals.enabled_sources:${workspaceId}`;
  await tenantClient.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * Whether one more source of the kind may be enabled, under the workspace's lock: the sender
 * account's tracked sources first, then the enabled sources in no agent, where a new one is; past
 * either, false for `disable`, else the limit's code.
 */
async function roomForOne(
  kind: SourceKind,
  config: unknown,
  senderAccountId: string | null,
  overLimit: OverLimit,
): Promise<boolean> {
  try {
    if (senderAccountId !== null && tracks(kind, config)) {
      await assertRoomForOneTracked(senderAccountId);
    }
    await assertRoomForOneMore();
    return true;
  } catch (error) {
    const limits: string[] = [errors.signal_tracked_limit, errors.signal_sources_limit];
    if (overLimit === "disable" && isAppError(error) && limits.includes(error.code)) return false;
    throw error;
  }
}

/**
 * signal_sources_limit when SIGNALS_MAX_ENABLED_SOURCES of the source's group are enabled already:
 * its agent's sources, or, for one in no agent (a new one, no id), the sources in no agent.
 */
async function assertRoomForOneMore(sourceId?: string): Promise<void> {
  const limit = settings.SIGNALS_MAX_ENABLED_SOURCES;
  const where = { enabled: true, ...(await groupOf(sourceId)) };
  const enabled = await tenantClient.signalSource.count({ where });
  if (enabled >= limit) throw new AppError(errors.signal_sources_limit, { details: { limit } });
}

/**
 * A source of the kind tracks a creator or a page for its sender account (RB-4.2.1): its posts reader
 * reads an author's posts, a member's or a company page's, as the competitor and creator kinds do.
 * Read from the kind, so no list of kinds is kept here.
 */
function tracks(kind: SourceKind, config: unknown): boolean {
  return isPostsReader(kind.reader) && kind.reader.source(config).by === "author";
}

/**
 * signal_tracked_limit when SIGNALS_MAX_TRACKED_PER_ACCOUNT enabled sources of the sender account
 * track an author already; counted under the workspace's lock (lockEnabledSources), the account's
 * own workspace.
 */
async function assertRoomForOneTracked(senderAccountId: string): Promise<void> {
  const limit = settings.SIGNALS_MAX_TRACKED_PER_ACCOUNT;
  const enabled = await tenantClient.signalSource.findMany({
    where: { enabled: true, senderAccountId },
    select: { kind: true, config: true },
  });
  const kinds = registeredSourceKinds();
  const tracked = enabled.filter(({ kind, config }) => {
    const registered = kinds.get(kind);
    return registered !== undefined && tracks(registered, config);
  });
  if (tracked.length >= limit) {
    throw new AppError(errors.signal_tracked_limit, { details: { limit } });
  }
}

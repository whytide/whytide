// The daily runs (README.md "Runs"; docs/flows.md; gamma-p5-040). The global tick's step starts, in
// each workspace's own run, a run of every source due, written as Run now writes one; a run's start
// takes its account's quota day and its share of the day's reads (shareOf), by agent (gamma-p5-045);
// the screen reads whether a source's last run ended at its budget. linkedin's readsLeftToday answers
// the quota day, the reads left (0 under a kill switch, the account's pause or a disconnect) and the
// window: no provider call. A paused agent's sources read nothing (paused-agent-sources): the tick
// writes them no run, and the share leaves them out. A research source's run (gamma-wr-030) is written
// by the same tick (research.ts): it has no account, so no reads, quota day or share.
import { tenantClient, withTenant } from "@whytide/db";
import { errors as linkedinErrors, type ReadsLeft, readsLeftToday } from "@whytide/linkedin";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { settings } from "../../settings.ts";
import { registeredSourceKinds } from "../../sources/registry.ts";
import { agentsBySource, pausedAgentSources } from "../agents.ts";
import { givenClient } from "../client.ts";
import { BUDGET_REACHED } from "../constants.ts";
import { requestRun } from "../sources.ts";
import { DAILY_RUNS_SERVICE, READING, UNENDED } from "./constants.ts";
import { writeDueResearchRuns } from "./research.ts";
import { shareOf } from "./share.ts";

/** A run as the due rule and the share read it. */
type RunState = { readonly status: string; readonly quotaDay: string | null };
const unended: readonly string[] = UNENDED;
const reading: readonly string[] = READING;
/** A run's quota day and read budget, set at its start. */
export type RunBudget = { readonly quotaDay: string; readonly readBudget: number };

/** The kind's cadence, `daily`, `research` or null; null for a kind no longer registered. */
export const cadenceOf = (kind: string): "daily" | "research" | null =>
  registeredSourceKinds().get(kind)?.cadence ?? null;

/** The run's counts say its budget, the cap or the 200 ended its reading. */
export function budgetReachedIn(counts: unknown): boolean {
  const reached = (counts as Record<string, unknown> | null)?.[BUDGET_REACHED];
  return typeof reached === "number" && reached > 0;
}

/**
 * A daily source is due: none of its runs open or about to start, none started on its account's
 * quota day, whatever started it (its save, Run now or a tick), its account's window open and more
 * than SIGNALS_READS_KEPT_FOR_SENDS reads left.
 */
export function isDue(
  reads: Pick<ReadsLeft, "quotaDay" | "left" | "windowOpen">,
  runs: readonly RunState[],
): boolean {
  if (!reads.windowOpen || reads.left <= settings.SIGNALS_READS_KEPT_FOR_SENDS) return false;
  return !runs.some(
    ({ status, quotaDay }) => unended.includes(status) || quotaDay === reads.quotaDay,
  );
}

/**
 * The daily tick's step, global: tenancy's workspaces, each in its own run as a service, where every
 * source due gets its run (writeDueRuns). A workspace that fails leaves the others started, and the
 * tick then fails with its code. The counts only.
 */
export async function startDailyRuns(): Promise<{ workspaces: number; started: number }> {
  // Tenancy's list: no module reads another's tables (decisions.md, 2026-10-22).
  const workspaceIds = await listWorkspaceIds();
  const principal = servicePrincipal(DAILY_RUNS_SERVICE);
  const failures: unknown[] = [];
  let started = 0;
  for (const workspaceId of workspaceIds) {
    try {
      started += await withTenant({ workspaceId, principal }, writeDueRuns, {
        client: givenClient(),
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  return { workspaces: workspaceIds.length, started };
}

/**
 * In the workspace's run: each enabled source of a daily kind that is due (isDue), then each research
 * source that is due (research.ts), gets its run, `scheduled`, with signals.run_requested, on which
 * the worker starts it, as Run now writes one. The count of the runs written.
 */
export async function writeDueRuns(): Promise<number> {
  return (await writeDueDailyRuns()) + (await writeDueResearchRuns());
}

/**
 * Each enabled source of a daily kind that is due (isDue) gets its run. A source whose account is
 * gone is skipped, and so is a source whose agent is paused, which reads nothing. The count of the
 * runs written.
 */
async function writeDueDailyRuns(): Promise<number> {
  const enabled = await tenantClient.signalSource.findMany({
    where: { enabled: true },
    select: { id: true, kind: true, senderAccountId: true },
    orderBy: { id: "asc" },
  });
  const ofDailyKinds = enabled.flatMap(({ senderAccountId, ...source }) =>
    cadenceOf(source.kind) === "daily" && senderAccountId !== null
      ? [{ ...source, senderAccountId }]
      : [],
  );
  if (ofDailyKinds.length === 0) return 0;
  const paused = await pausedAgentSources();
  const daily = ofDailyKinds.filter(({ id }) => !paused.has(id));
  if (daily.length === 0) return 0;
  const accounts = new Map<string, ReadsLeft | null>();
  for (const { senderAccountId } of daily) {
    if (!accounts.has(senderAccountId))
      accounts.set(senderAccountId, await readsOf(senderAccountId));
  }
  const days = [...accounts.values()].flatMap((reads) => (reads === null ? [] : [reads.quotaDay]));
  const runs = await runsOf(
    daily.map(({ id }) => id),
    days,
  );
  let written = 0;
  for (const source of daily) {
    const reads = accounts.get(source.senderAccountId) ?? null;
    if (reads === null || !isDue(reads, runs.get(source.id) ?? [])) continue;
    await requestRun(source.id);
    written += 1;
  }
  return written;
}

/**
 * A run's quota day and read budget, at its start: its account's reads left today shared by the
 * account's sources still due today, this run's counted: every other source with a run reading now,
 * from the same reads, and the other enabled sources of a daily kind with no run of the quota day.
 * They share by group: each agent with one of them, and those in no agent, gets an even part, which
 * its sources share evenly. A paused agent's sources share nothing, a run of one still reading too:
 * they read nothing, and the pause asked that run's stop.
 */
export async function readBudgetOf(sourceId: string, accountId: string): Promise<RunBudget> {
  const { quotaDay, left } = await readsLeftToday(accountId);
  const paused = await pausedAgentSources();
  const others = (
    await tenantClient.signalSource.findMany({
      where: { senderAccountId: accountId, id: { not: sourceId } },
      select: { id: true, kind: true, enabled: true },
    })
  ).filter(({ id }) => !paused.has(id));
  const runs =
    others.length === 0
      ? new Map()
      : await runsOf(
          others.map(({ id }) => id),
          [quotaDay],
        );
  const sharing = others.filter(({ id, kind, enabled }) => {
    const own: readonly RunState[] = runs.get(id) ?? [];
    if (own.some(({ status }) => reading.includes(status))) return true;
    return enabled && cadenceOf(kind) === "daily" && !own.some((run) => run.quotaDay === quotaDay);
  });
  const agents = await agentsBySource();
  const groupKey = (id: string) => agents.get(id)?.id ?? null;
  const due = [sourceId, ...sharing.map(({ id }) => id)].map(groupKey);
  const own = groupKey(sourceId);
  const groups = {
    groups: new Set(due).size,
    inGroup: due.filter((group) => group === own).length,
  };
  return { quotaDay, readBudget: shareOf(left, groups, settings.SIGNALS_READS_KEPT_FOR_SENDS) };
}

/**
 * The listed sources whose last run, the one their `last_run_at` names, ended done at its budget
 * (`counts.budget_reached`): their cards say so.
 */
export async function lastRunsAtBudget(
  sources: readonly { readonly id: string; readonly lastRunAt: Date | null }[],
): Promise<Set<string>> {
  const last = sources.flatMap(({ id, lastRunAt }) =>
    lastRunAt === null ? [] : [{ sourceId: id, startedAt: lastRunAt }],
  );
  if (last.length === 0) return new Set();
  const runs = await tenantClient.signalRun.findMany({
    where: { status: "done", OR: last },
    select: { sourceId: true, counts: true },
  });
  return new Set(runs.filter((run) => budgetReachedIn(run.counts)).map((run) => run.sourceId));
}

/** The account's reads today; null when the account is gone. */
async function readsOf(accountId: string): Promise<ReadsLeft | null> {
  try {
    return await readsLeftToday(accountId);
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}

/** The sources' runs not over, and those of the quota days, by source. */
async function runsOf(sourceIds: readonly string[], quotaDays: readonly string[]) {
  const rows = await tenantClient.signalRun.findMany({
    where: {
      sourceId: { in: [...sourceIds] },
      OR: [{ status: { in: [...UNENDED] } }, { quotaDay: { in: [...quotaDays] } }],
    },
    select: { sourceId: true, status: true, quotaDay: true },
  });
  const bySource = new Map<string, RunState[]>();
  for (const { sourceId, ...run } of rows) {
    bySource.set(sourceId, [...(bySource.get(sourceId) ?? []), run]);
  }
  return bySource;
}

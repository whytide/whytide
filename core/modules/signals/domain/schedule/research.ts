// The research runs the daily tick writes (README.md "Runs"; gamma-wr-030). A source of a kind with the
// cadence `research` has no Temporal schedule and no account: it is due when it is enabled, its agent
// is active, none of its runs is scheduled, running or waiting, and none started within the last
// SIGNALS_RESEARCH_EVERY_DAYS days, whatever started it. So its first run comes at the next tick after
// it joins an agent, and a source in no agent runs on Run now alone. Its run is written as Run now
// writes one (`scheduled` and signals.run_requested), and the worker starts signals_research_run.
import { tenantClient } from "@whytide/db";
import { settings } from "../../settings.ts";
import { registeredSourceKinds } from "../../sources/registry.ts";
import { agentsBySource, pausedAgentSources } from "../agents.ts";
import { requestRun } from "../sources.ts";
import { DAY_MS, UNENDED } from "./constants.ts";

/** A run as the due rule reads it: its status and its start. */
type RunState = { readonly status: string; readonly startedAt: Date | null };
const unended: readonly string[] = UNENDED;

/** The kind has the research cadence. */
export const isResearchKind = (kind: string): boolean =>
  registeredSourceKinds().get(kind)?.cadence === "research";

/**
 * A research source is due: none of its runs open or about to start, and none started within the last
 * `everyDays` days (SIGNALS_RESEARCH_EVERY_DAYS), whatever started it.
 */
export function isResearchDue(runs: readonly RunState[], now: Date, everyDays: number): boolean {
  const since = now.getTime() - everyDays * DAY_MS;
  return !runs.some(
    ({ status, startedAt }) =>
      unended.includes(status) || (startedAt !== null && startedAt.getTime() > since),
  );
}

/**
 * In the workspace's run: each enabled research source in an active agent that is due gets its run,
 * `scheduled`, with signals.run_requested. A source in no agent, and one in a paused agent, gets
 * none. The count of the runs written.
 */
export async function writeDueResearchRuns(now = new Date()): Promise<number> {
  const enabled = await tenantClient.signalSource.findMany({
    where: { enabled: true },
    select: { id: true, kind: true },
    orderBy: { id: "asc" },
  });
  const researching = enabled.filter(({ kind }) => isResearchKind(kind));
  if (researching.length === 0) return 0;
  const [agents, paused] = [await agentsBySource(), await pausedAgentSources()];
  const held = researching.filter(({ id }) => agents.has(id) && !paused.has(id));
  if (held.length === 0) return 0;
  const since = new Date(now.getTime() - settings.SIGNALS_RESEARCH_EVERY_DAYS * DAY_MS);
  const rows = await tenantClient.signalRun.findMany({
    where: {
      sourceId: { in: held.map(({ id }) => id) },
      OR: [{ status: { in: [...UNENDED] } }, { startedAt: { gt: since } }],
    },
    select: { sourceId: true, status: true, startedAt: true },
  });
  let written = 0;
  for (const { id } of held) {
    const runs = rows.filter(({ sourceId }) => sourceId === id);
    if (!isResearchDue(runs, now, settings.SIGNALS_RESEARCH_EVERY_DAYS)) continue;
    await requestRun(id);
    written += 1;
  }
  return written;
}

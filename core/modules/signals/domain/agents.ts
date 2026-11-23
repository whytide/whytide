// What signals reads of playbooks (README.md "Decided here"; gamma-p5-045), in the caller's tenant
// run: each source's agent, the group a source counts in for the enabled limit and the read share,
// and a run's audience; whether a source's agent reads, as a paused agent's sources read nothing
// (paused-agent-sources). playbooks' readers run on the run's transaction (tenantClient), so they see
// the workspace's links only. Signals writes no link: its delete calls playbooks' detachSource.
import { type IcpForScoring, readIcpForScoring } from "@whytide/icp";
import { getPlaybook, listPlaybooks, playbookOfSource, sourcesOf } from "@whytide/playbooks";
import { READING_AGENT_STATUS } from "./constants.ts";

/** A source's agent as the api answers it. */
export type SourceAgent = { readonly id: string; readonly name: string };
/** A source's agent as a run's start and Run now read it: its id, and whether it is active. */
export type AgentState = { readonly id: string; readonly active: boolean };
/** The sources of one group, as a where on signal_sources: an agent's, or those in no agent. */
export type GroupWhere = { readonly id: { in: string[] } | { notIn: string[] } };

/** The agent of each source an agent holds, by source id; a source in no agent is no key. */
export async function agentsBySource(): Promise<Map<string, SourceAgent>> {
  const agents = new Map<string, SourceAgent>();
  for (const { id, name, sourceCount } of await listPlaybooks()) {
    if (sourceCount === 0) continue;
    for (const sourceId of await sourcesOf(id)) agents.set(sourceId, { id, name });
  }
  return agents;
}

/**
 * The agent the source is in and whether it is active: only an active agent's sources read, a
 * paused one's read nothing, whatever the pause's reason. Null for a source in no agent, which reads
 * as before.
 */
export async function agentStateOf(sourceId: string): Promise<AgentState | null> {
  const playbookId = await playbookOfSource(sourceId);
  if (playbookId === null) return null;
  const active = (await getPlaybook(playbookId))?.status === READING_AGENT_STATUS;
  return { id: playbookId, active };
}

/** The sources of the workspace's agents that are not active, which read nothing, by id. */
export async function pausedAgentSources(): Promise<Set<string>> {
  const paused = new Set<string>();
  for (const { id, status, sourceCount } of await listPlaybooks()) {
    if (status === READING_AGENT_STATUS || sourceCount === 0) continue;
    for (const sourceId of await sourcesOf(id)) paused.add(sourceId);
  }
  return paused;
}

/** The agent's sources while it is not active, by id; none for an agent active now, or not found. */
export async function pausedSourcesOf(playbookId: string): Promise<string[]> {
  const playbook = await getPlaybook(playbookId);
  if (playbook === null || playbook.status === READING_AGENT_STATUS) return [];
  return sourcesOf(playbook.id);
}

/**
 * The sources that count with this one against SIGNALS_MAX_ENABLED_SOURCES: its agent's, or, for a
 * source in no agent, a new one (no id) included, every source in no agent.
 */
export async function groupOf(sourceId?: string): Promise<GroupWhere> {
  const playbookId = sourceId === undefined ? null : await playbookOfSource(sourceId);
  if (playbookId !== null) return { id: { in: await sourcesOf(playbookId) } };
  return { id: { notIn: [...(await agentsBySource()).keys()] } };
}

/**
 * A run's audience: that of the agent its start found the source in (`playbookId`), else the
 * workspace's default. Its hard filters, its read order and its noise rules' exceptions read it.
 */
export async function audienceOf(workspaceId: string, playbookId?: string): Promise<IcpForScoring> {
  const playbook = playbookId === undefined ? null : await getPlaybook(playbookId);
  return readIcpForScoring(workspaceId, playbook?.icpId);
}

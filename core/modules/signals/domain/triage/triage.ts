// The triage of a run's candidates (README.md "Triage"; docs/flows.md; signals-triage-ai), steps of
// the run between the cheap drops and the first profile read, a batch at a time: the headlines read
// in a tenant run, triaged by the agent signals.triage-engagers outside any run, a request file
// written for each candidate read, and the skips deleted and counted in another run. A batch the
// triage could not answer is decided by the rules, as before it: the recruiter and job-seeker terms
// on the headline (noise.ts), then the title rule's rank (select.ts's rankOf). The headlines go
// from the database to the model inside the step, never through the workflow's history: ids out.
// The ICP is the run's audience: its agent's, else the default (agents.ts, gamma-p5-045).
import { callAgent, registeredAgentTasks } from "@whytide/ai";
import { tenantClient } from "@whytide/db";
import type { Icp } from "@whytide/icp";
import { AppError, isAppError } from "@whytide/platform";
import type { triageEngagersTask } from "../../agents/triage-engagers/task.ts";
import { errors } from "../../errors.ts";
import {
  TRIAGE_ENGAGERS,
  type TriageEngagersInput,
  type TriageEngagersOutput,
} from "../../schemas/triage-engagers.ts";
import { audienceOf } from "../agents.ts";
import { givenClient } from "../client.ts";
import type { NoiseRules } from "../process/noise.ts";
import { noiseRulesOf, rankOf, type Selected, writeRequests } from "../process/select.ts";
import { scrub } from "../rate/scrub.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef } from "../runs.ts";
import { READ_FIRST } from "../schedule/constants.ts";

/** The count of the candidates the triage skipped, with no hash, as a noise drop. */
export const TRIAGE_DROP = "dropped_triage";

/** A batch's ids in the read order's three ranks: authors and commenters, read first, the rest. */
export type Ranks = [first: string[], fits: string[], rest: string[]];
/** A staged candidate as the triage reads it; its member reference stays in the table. */
export type Staged = Selected & {
  readonly name: string;
  readonly headline: string;
  readonly reaction: string;
};
/** The ICP's targeting as the triage reads it. */
export type TriageIcp = Pick<Icp, "titles" | "seniorities" | "industries" | "mustHaves">;
/** A batch decided: the candidates dropped, each with its count's name, and the ranks of the rest. */
export type Decided = {
  readonly dropped: ReadonlyMap<string, string>;
  readonly ranks: [Staged[], Staged[], Staged[]];
};
/** A batch read: the ICP, its noise rules and the candidates still staged. */
export type Read = {
  readonly icp: TriageIcp;
  readonly noise: NoiseRules;
  readonly staged: readonly Staged[];
};

/**
 * The batch triaged (signals_triage_candidates): read in one tenant run, the agent asked outside any,
 * the decisions written; the ranks. An ai_failed answer (its schema or its gate failed twice) and a
 * batch over the agent's budget are decided by the rules in the same step; an llm_* code throws,
 * for the activity's attempts, after which the run decides the batch by the rules (triageByRules).
 * The decision record's subject is the workspace: erasePerson erases every triage record with it.
 */
export async function triageCandidates(
  ref: RunRef,
  candidateIds: readonly string[],
  tenant: TenantRun,
): Promise<{ ranks: Ranks }> {
  const task = registeredTask();
  const read = await tenant(() => readBatch(ref, candidateIds));
  if (read.staged.length === 0) return { ranks: [[], [], []] };
  const client = givenClient();
  const { workspaceId } = ref;
  const call = { workspaceId, subjectRef: workspaceId, input: batchOf(read.icp, read.staged) };
  const result = await callAgent(task, call, client === undefined ? {} : { client }).catch(
    (error: unknown) => {
      if (isAppError(error) && error.code === "ai_budget_exceeded") return null;
      throw error;
    },
  );
  const answered = result !== null && result.status === "ok";
  const decided = answered ? byTriage(read.staged, result.output) : byRules(read);
  return write(ref, decided, tenant);
}

/** A batch the triage could not answer (signals_triage_fallback), decided by the rules. */
export async function triageByRules(
  ref: RunRef,
  candidateIds: readonly string[],
  tenant: TenantRun,
): Promise<{ ranks: Ranks }> {
  const read = await tenant(() => readBatch(ref, candidateIds));
  return write(ref, byRules(read), tenant);
}

/**
 * The batch as the model reads it: the ICP's titles, seniorities, industries and must-haves, and each
 * candidate, indexed from 1 in the staged order, its role (a like and a repost are reactions) and its
 * headline scrubbed with its name; never a name, a profile URL, a company or a member reference.
 */
export function batchOf(
  icp: TriageIcp,
  staged: readonly Pick<Staged, "name" | "headline" | "reaction">[],
): TriageEngagersInput {
  const { titles, seniorities, industries, mustHaves } = icp;
  return {
    icp: {
      titles: [...titles],
      seniorities: [...seniorities],
      industries: [...industries],
      mustHaves,
    },
    candidates: staged.map(({ name, headline, reaction }, n) => ({
      index: n + 1,
      role: reaction === "author" || reaction === "comment" ? reaction : "reaction",
      headline: scrub(headline, name) ?? "",
    })),
  };
}

/**
 * The batch decided by the triage's answer, by index in the staged order: a skip dropped, counted
 * TRIAGE_DROP; authors and commenters first unless skipped, then read_first, then read. The gate
 * leaves no candidate undecided; one would be read.
 */
export function byTriage(staged: readonly Staged[], output: TriageEngagersOutput): Decided {
  const decisions = new Map(output.decisions.map(({ index, decision }) => [index, decision]));
  const dropped = new Map<string, string>();
  const ranks: Decided["ranks"] = [[], [], []];
  for (const [n, candidate] of staged.entries()) {
    const decision = decisions.get(n + 1) ?? "read";
    if (decision === "skip") dropped.set(candidate.id, TRIAGE_DROP);
    else if (READ_FIRST.includes(candidate.reaction)) ranks[0].push(candidate);
    else ranks[decision === "read_first" ? 1 : 2].push(candidate);
  }
  return { dropped, ranks };
}

/**
 * The batch decided by the rules, as a run before the triage decides it: a recruiter or a job seeker
 * by the headline dropped with the noise rule's reason, the rest in the title rule's ranks.
 */
export function byRules({ icp, noise, staged }: Read): Decided {
  const rank = rankOf(icp.titles);
  const dropped = new Map<string, string>();
  const ranks: Decided["ranks"] = [[], [], []];
  for (const candidate of staged) {
    const reason = noise.headline(candidate.headline);
    if (reason === null) ranks[rank(candidate)].push(candidate);
    else dropped.set(candidate.id, reason);
  }
  return { dropped, ranks };
}

/** The batch's candidates still staged, oldest first, with the run's audience and its noise rules. */
async function readBatch(
  { workspaceId, runId, playbookId }: RunRef,
  candidateIds: readonly string[],
): Promise<Read> {
  const { icp } = await audienceOf(workspaceId, playbookId);
  const staged = await tenantClient.signalCandidate.findMany({
    where: { runId, id: { in: [...candidateIds] } },
    select: { id: true, profileUrl: true, name: true, headline: true, reaction: true },
    orderBy: { id: "asc" },
  });
  return { icp, noise: await noiseRulesOf(icp), staged };
}

/**
 * The decisions written: each candidate read gets its request file, outside any run, then the
 * dropped are deleted and counted in a run, so that a retry finds the same batch and the cache's
 * answer; the ranks' ids.
 */
async function write(ref: RunRef, decided: Decided, tenant: TenantRun): Promise<{ ranks: Ranks }> {
  await writeRequests(ref.workspaceId, ref.runId, decided.ranks.flat());
  await tenant(async () => {
    const counts: Record<string, number> = {};
    for (const reason of new Set(decided.dropped.values())) {
      const ids = [...decided.dropped].flatMap(([id, why]) => (why === reason ? [id] : []));
      const where = { runId: ref.runId, id: { in: ids } };
      counts[reason] = (await tenantClient.signalCandidate.deleteMany({ where })).count;
    }
    await addCounts(ref.runId, counts);
  });
  const [first, fits, rest] = decided.ranks.map((rank) => rank.map(({ id }) => id));
  return { ranks: [first ?? [], fits ?? [], rest ?? []] };
}

/** The task the host registered at start (loadAgentTasks); never imported here (agents/). */
function registeredTask(): typeof triageEngagersTask {
  const task = registeredAgentTasks().get(TRIAGE_ENGAGERS);
  if (task === undefined) throw new AppError(errors.signal_triage_agent_not_loaded);
  return task as unknown as typeof triageEngagersTask;
}

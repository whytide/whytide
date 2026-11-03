// The runs that read a person, for credits' cost counter (alpha-p10-010; README "Public interface"):
// each run the person has an event from, the candidates it staged, over which credits share what a
// run started before beta-p1-090 paid for its engagers read, how many of them were the person's, one
// per reaction kept, and their ids, the subjects of what a later run paid for their profile reads
// (beta-p1-090): an event's id carries its candidate's ULID (ids.ts). In the caller's tenant run; a
// run deleted since (its events' run_id null) read no one.
import { tenantClient } from "@whytide/db";
import { candidateIdOf } from "../ids.ts";

export type PersonRead = {
  readonly runId: string;
  /** The run's candidates (its counts' `staged`), never fewer than the person's own. */
  readonly candidates: number;
  /** The person's candidates among them: the person's events from the run. */
  readonly personCandidates: number;
  /**
   * Their ids, sorted, one per event: a candidate's credit's subject. An event made before
   * beta-p1-090 gives an id no candidate had, as its run paid by blocks.
   */
  readonly candidateIds: readonly string[];
};

/** By run id. */
export async function personReads(personId: string): Promise<PersonRead[]> {
  const events = await tenantClient.signalEvent.findMany({
    where: { personId, runId: { not: null } },
    select: { id: true, runId: true },
  });
  const byRun = new Map<string, string[]>();
  for (const { id, runId } of events) {
    if (runId !== null) byRun.set(runId, [...(byRun.get(runId) ?? []), candidateIdOf(id)]);
  }
  const runs = await tenantClient.signalRun.findMany({
    where: { id: { in: [...byRun.keys()] } },
    select: { id: true, counts: true },
  });
  const staged = new Map(runs.map(({ id, counts }) => [id, stagedOf(counts)]));
  return [...byRun]
    .map(([runId, candidateIds]) => {
      const personCandidates = candidateIds.length;
      const candidates = Math.max(staged.get(runId) ?? 0, personCandidates);
      return { runId, candidates, personCandidates, candidateIds: candidateIds.sort() };
    })
    .sort((a, b) => (a.runId < b.runId ? -1 : 1));
}

function stagedOf(counts: unknown): number {
  const staged = (counts as Record<string, unknown> | null)?.staged;
  return typeof staged === "number" && Number.isInteger(staged) ? staged : 0;
}

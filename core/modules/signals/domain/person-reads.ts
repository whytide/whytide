// The runs that read a person, for credits' cost counter (alpha-p10-010; README "Public interface"):
// each run the person has an event from, the candidates it staged, over which credits share what its
// engagers read cost, and how many of them were the person's, one per reaction kept. In the caller's
// tenant run; a run deleted since (its events' run_id null) read no one.
import { tenantClient } from "@whytide/db";

export type PersonRead = {
  readonly runId: string;
  /** The run's candidates (its counts' `staged`), never fewer than the person's own. */
  readonly candidates: number;
  /** The person's candidates among them: the person's events from the run. */
  readonly personCandidates: number;
};

/** By run id. */
export async function personReads(personId: string): Promise<PersonRead[]> {
  const events = await tenantClient.signalEvent.groupBy({
    by: ["runId"],
    where: { personId, runId: { not: null } },
    _count: { _all: true },
  });
  const runIds = events.flatMap(({ runId }) => runId ?? []);
  const runs = await tenantClient.signalRun.findMany({
    where: { id: { in: runIds } },
    select: { id: true, counts: true },
  });
  const staged = new Map(runs.map(({ id, counts }) => [id, stagedOf(counts)]));
  return events
    .flatMap(({ runId, _count }) => {
      if (runId === null) return [];
      const personCandidates = _count._all;
      const candidates = Math.max(staged.get(runId) ?? 0, personCandidates);
      return [{ runId, candidates, personCandidates }];
    })
    .sort((a, b) => (a.runId < b.runId ? -1 : 1));
}

function stagedOf(counts: unknown): number {
  const staged = (counts as Record<string, unknown> | null)?.staged;
  return typeof staged === "number" && Number.isInteger(staged) ? staged : 0;
}

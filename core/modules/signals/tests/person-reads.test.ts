// personReads (README "Public interface"), for credits' share of a run's reads: each run a person has
// events from, by run id, with the candidates it staged, the person's among them and their ids, the
// subjects of their engager credits (beta-p1-090). An event of no run, another person's or a run's
// that counted none is not one more of the person's.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { personReads } from "../domain/person-reads.ts";
import { candidateIdOf, eventIdOf, ids } from "../ids.ts";
import { createSignalEvent, createSignalRun, createSignalSource } from "../testing/index.ts";

withTestDb();
const workspaceId = "wsp_signals_person_reads";
const principal = servicePrincipal("signals_test");
const reads = (personId: string) =>
  withTenant({ workspaceId, principal }, () => personReads(personId), { client: asRole("app") });

test("personReads: per run, the candidates it staged, the person's and their ids, an event's candidate since beta-p1-090 and an id no candidate had before; none for an imported person", async () => {
  const { id: sourceId } = await createSignalSource({ workspaceId, label: "Launch post" });
  const run = (counts: Record<string, number>) =>
    createSignalRun({ workspaceId, sourceId, status: "done", counts });
  const first = await run({ pages: 4, read: 95, staged: 80, created: 2 });
  const second = await run({ pages: 1, read: 10, staged: 9 });
  const uncounted = await run({});
  const event = (
    runId?: string,
    commentText?: string,
    personId = "per_reader",
    candidateId?: string,
  ) => createSignalEvent({ workspaceId, personId, sourceId, runId, commentText, candidateId });
  // Made before beta-p1-090: their ids name no candidate.
  const like = await event(first.id);
  const comment = await event(first.id, "Useful, thanks");
  const old = await event(uncounted.id);
  // Made since: the event's id carries its candidate's ULID.
  const candidate = newId(ids.signal_candidate);
  const made = await event(second.id, undefined, "per_reader", candidate);
  assert.deepEqual([made.id, candidateIdOf(made.id)], [eventIdOf(candidate), candidate]);
  await event(undefined);
  await event(second.id, undefined, "per_other");
  const nameless = (...events: { id: string }[]) =>
    events.map(({ id }) => candidateIdOf(id)).sort();
  const expected = [
    { runId: first.id, candidates: 80, personCandidates: 2, candidateIds: nameless(like, comment) },
    { runId: second.id, candidates: 9, personCandidates: 1, candidateIds: [candidate] },
    { runId: uncounted.id, candidates: 1, personCandidates: 1, candidateIds: nameless(old) },
  ].sort((a, b) => (a.runId < b.runId ? -1 : 1));
  assert.deepEqual(await reads("per_reader"), expected);
  assert.deepEqual(await reads("per_imported"), []);
});

// personReads (README "Public interface"), for credits' share of a run's reads: each run a person has
// events from, by run id, with the candidates it staged and the person's among them. An event of no
// run, another person's or a run's that counted none is not one more of the person's.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { personReads } from "../domain/person-reads.ts";
import { createSignalEvent, createSignalRun, createSignalSource } from "../testing/index.ts";

withTestDb();
const workspaceId = "wsp_signals_person_reads";
const principal = servicePrincipal("signals_test");
const reads = (personId: string) =>
  withTenant({ workspaceId, principal }, () => personReads(personId), { client: asRole("app") });

test("personReads: per run, the candidates it staged and the person's; none for an imported person", async () => {
  const { id: sourceId } = await createSignalSource({ workspaceId, label: "Launch post" });
  const run = (counts: Record<string, number>) =>
    createSignalRun({ workspaceId, sourceId, status: "done", counts });
  const first = await run({ pages: 4, read: 95, staged: 80, created: 2 });
  const second = await run({ pages: 1, read: 10, staged: 9 });
  const uncounted = await run({});
  const event = (runId?: string, commentText?: string, personId = "per_reader") =>
    createSignalEvent({ workspaceId, personId, sourceId, runId, commentText });
  await event(first.id);
  await event(first.id, "Useful, thanks");
  await event(second.id);
  await event(uncounted.id);
  await event(undefined);
  await event(second.id, undefined, "per_other");
  const expected = [
    { runId: first.id, candidates: 80, personCandidates: 2 },
    { runId: second.id, candidates: 9, personCandidates: 1 },
    { runId: uncounted.id, candidates: 1, personCandidates: 1 },
  ].sort((a, b) => (a.runId < b.runId ? -1 : 1));
  assert.deepEqual(await reads("per_reader"), expected);
  assert.deepEqual(await reads("per_imported"), []);
});

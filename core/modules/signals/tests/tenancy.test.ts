// test:tenancy for signal_sources, signal_runs, signal_candidates, signal_events and evidence
// (docs/rules/security.md §3; core/packages/db README "Register a tenant table in the isolation
// test"): rows made by the module's commands, or its factories for runs and events, and read in a run
// of one workspace, scoped by the tenant client alone, are that workspace's only; every command and
// query of domain/sources.ts, the run's steps of domain/runs.ts and domain/process/, the evidence
// reads, the person's reads and the reduction's batch go through the tenant client; a candidate holds
// the staged business fields only; erasePerson deletes a person's events and their evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { createConnectedAccount, useLinkedinClient } from "@whytide/linkedin/testing";
import { servicePrincipal } from "@whytide/platform";
import { erasePerson, listEvidence } from "../domain/evidence.ts";
import { personReads } from "../domain/person-reads.ts";
import { processCandidates } from "../domain/process/process.ts";
import { selectCandidates } from "../domain/process/select.ts";
import { reduceBatch, reductionCuts } from "../domain/reduce/reduce.ts";
import { addCounts, endRun, reserveRead, stagePage, startRun } from "../domain/runs.ts";
import {
  createSource,
  deleteSource,
  listRuns,
  listSources,
  requestRun,
  stopRun,
  updateSource,
} from "../domain/sources.ts";
import { createSignalEvent, createSignalRun } from "../testing/index.ts";

const db = withTestDb();
const principal = servicePrincipal("signals_test");
const client = asRole("app");
useLinkedinClient(client);
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client });
const newSource = (senderAccountId: string) => ({
  kind: "post_engagers",
  config: { postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000" },
  label: "Launch post",
  senderAccountId,
});
/** A source on a connected account of the workspace, as the route creates one. */
async function sourceIn(workspaceId: string) {
  const { id } = await createConnectedAccount(workspaceId);
  return inRun(workspaceId, () => createSource(newSource(id)));
}
const ref = { workspaceId: "wsp_none", sourceId: "src_none", runId: "run_none" };
const page = {
  number: 1,
  key: "raw/signals/run_none/1.json",
  cutAt: new Date(0).toISOString(),
  read: 1,
};
const file = {
  engagers: [
    {
      providerMemberRef: "member-1",
      profileUrl: "https://www.linkedin.com/in/member-1",
      name: "Member 1",
      headline: "Head of sales",
      reaction: "like",
      engagedAt: "2026-10-21T10:00:00.000Z",
    },
  ],
};

isolationTest("signal_sources", {
  createRow: (workspaceId) => sourceIn(workspaceId),
  readAs: (workspaceId) => inRun(workspaceId, () => listSources()),
});

isolationTest("signal_runs", {
  async createRow(workspaceId) {
    const source = await sourceIn(workspaceId);
    return createSignalRun({ workspaceId, sourceId: source.id });
  },
  readAs: (workspaceId) =>
    withTenant({ workspaceId, principal }, (tx) => tx.signalRun.findMany(), { client }),
});

isolationTest("signal_candidates", {
  async createRow(workspaceId) {
    const source = await sourceIn(workspaceId);
    const run = await inRun(workspaceId, () => requestRun(source.id));
    const staged = { workspaceId, sourceId: source.id, runId: run.id };
    await inRun(workspaceId, () => stagePage(staged, page, file));
    return client.signalCandidate.findFirstOrThrow({ where: { runId: run.id } });
  },
  readAs: (workspaceId) =>
    withTenant({ workspaceId, principal }, (tx) => tx.signalCandidate.findMany(), { client }),
});

isolationTest("signal_events", {
  createRow: (workspaceId) => createSignalEvent({ workspaceId, personId: "per_isolation" }),
  readAs: (workspaceId) =>
    withTenant({ workspaceId, principal }, (tx) => tx.signalEvent.findMany(), { client }),
});

isolationTest("evidence", {
  async createRow(workspaceId) {
    const event = await createSignalEvent({ workspaceId, personId: "per_isolation" });
    return client.evidence.findFirstOrThrow({ where: { eventId: event.id } });
  },
  readAs: (workspaceId) =>
    withTenant({ workspaceId, principal }, (tx) => tx.evidence.findMany(), { client }),
});

test("erasePerson deletes the person's events and their evidence, and no one else's", async () => {
  const workspaceId = "wsp_erasure";
  await createSignalEvent({ workspaceId, personId: "per_erased" });
  await createSignalEvent({ workspaceId, personId: "per_erased", commentText: "Useful" });
  await createSignalEvent({ workspaceId, personId: "per_kept" });
  assert.deepEqual(await inRun(workspaceId, () => erasePerson("per_erased")), {
    signal_events: 2,
    evidence: 2,
  });
  const left = await client.signalEvent.findMany({ where: { workspaceId } });
  assert.deepEqual(
    left.map((event) => event.personId),
    ["per_kept"],
  );
  assert.equal(await client.evidence.count({ where: { workspaceId } }), 1);
});

test("every command and query on sources and runs, every step of a run, the person's reads and the reduction's batch, go through the tenant client", async () => {
  await assertScoped(() => createSource(newSource("sac_01JAB3K5ZQ7W9R2M4T6V8X0Y1C")));
  await assertScoped(() => listSources());
  await assertScoped(() => updateSource("src_unknown", { enabled: true }));
  await assertScoped(() => deleteSource("src_unknown"));
  await assertScoped(() => listRuns("src_unknown"));
  await assertScoped(() => requestRun("src_unknown"));
  await assertScoped(() => stopRun("src_unknown", "run_unknown"));
  await assertScoped(() => startRun(ref, "signals.run:wsp_none:run_none"));
  await assertScoped(() => reserveRead(ref, "sac_01JAB3K5ZQ7W9R2M4T6V8X0Y1C"));
  await assertScoped(() => stagePage(ref, page, file));
  await assertScoped(() => endRun(ref, { status: "done" }, { read: 0, billed: 0 }));
  await assertScoped(() => addCounts(ref.runId, { created: 1 }));
  await assertScoped(() => selectCandidates(ref, null));
  await assertScoped(() => processCandidates(ref, ["cand_none"], new Map(), null));
  await assertScoped(() => listEvidence("per_none"));
  await assertScoped(() => erasePerson("per_none"));
  await assertScoped(() => personReads("per_none"));
  const now = new Date();
  const cuts = reductionCuts([{ lookbackDays: 30, event: { kind: "post_engagement" } }], now);
  assert.ok(cuts);
  await assertScoped(() => reduceBatch(cuts, now));
});

test("signal_candidates holds the staged business fields, the run and the raw file's key, nothing else", async () => {
  const columns = await asRole("owner").$queryRaw<{ name: string }[]>`
    SELECT column_name AS name FROM information_schema.columns
    WHERE table_schema = ${db.schema} AND table_name = 'signal_candidates' ORDER BY column_name`;
  assert.deepEqual(
    columns.map(({ name }) => name),
    [
      "comment_text",
      "engaged_at",
      "headline",
      "id",
      "name",
      "profile_url",
      "provider_member_ref",
      "raw_ref",
      "reaction",
      "run_id",
      "workspace_id",
    ],
  );
});

// A paused agent's open runs (paused-agent-sources; README.md "Runs"), in this file's schema:
// playbooks.playbook_updated, delivered as the worker delivers it (deliverPending, each handler in a
// tenant run of the event's workspace), finds the agent paused, by a member or for its owner's
// removal, and stops each running or waiting run of its sources as Stop stops it: its
// stop_requested_at set and one signals.run_stop_requested, whose delivery asks the cancel of the
// run's workflow, on a canceller that records it. A scheduled run is its start's to end, and a
// source in no agent or in an active agent keeps its runs; a redelivery publishes no second stop; an
// agent active at the delivery stops and starts nothing. The run's end, the start's own check, the
// tick and the share: core/apps/worker/tests/signals-agent-runs.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { createOutboxStore, outboxWriter, tenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  bindWorkflowCanceller,
  collectLogs,
  createLogger,
  deliverPending,
  publish,
  servicePrincipal,
} from "@whytide/platform";
import { events as playbooks } from "@whytide/playbooks";
import { createPlaybook, pauseRemovedMember } from "@whytide/playbooks/testing";
import { runNowWorkflowIdOf } from "../domain/constants.ts";
import "../events.ts";
import { createSignalRun, createSignalSource } from "../testing/index.ts";

withTestDb();
const app = asRole("app");
const log = createLogger({ destination: collectLogs().destination });
const STOP = "signals.run_stop_requested";
const startedAt = new Date("2026-11-15T09:00:00.000Z");
/** The workflows whose cancel the deliveries asked for, in order. */
const cancelled: string[] = [];
bindWorkflowCanceller({
  cancel: async ({ workflowId }) => {
    cancelled.push(workflowId);
    return { cancelled: true };
  },
});

const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal: servicePrincipal("signals_test") }, fn, { client: app });

/** One pass of the worker's delivery, each handler in a tenant run of the event's workspace. */
async function deliver(): Promise<void> {
  const report = await deliverPending({
    store: createOutboxStore(app),
    runInTenant: (workspaceId, fn) =>
      withTenant({ workspaceId, principal: servicePrincipal("worker") }, fn, { client: app }),
    log,
  });
  assert.deepEqual([report.retried, report.dead], [0, 0], "every event delivered");
}

/** playbooks.playbook_updated for the agent, as its change publishes it. */
const updated = (workspaceId: string, playbookId: string, status: "active" | "paused") =>
  inRun(workspaceId, async () => {
    const outbox = outboxWriter(tenantClient, workspaceId);
    await publish(outbox, playbooks["playbooks.playbook_updated"], { playbookId, status });
  });

/** The payloads of `eventName` in the workspace's outbox, by run id. */
async function published(workspaceId: string, eventName: string) {
  const found = await app.outboxEntry.findMany({ where: { workspaceId, eventName } });
  const payloads = found.map(({ payload }) => payload as { run_id: string });
  return payloads.sort((a, b) => a.run_id.localeCompare(b.run_id));
}

/** Each run's status and whether its stop was asked, in the order of `ids`. */
async function runs(ids: readonly string[]) {
  const found = await app.signalRun.findMany({ where: { id: { in: [...ids] } } });
  const byId = new Map(found.map((run) => [run.id, run]));
  return ids.map((id) => [byId.get(id)?.status, byId.get(id)?.stopRequestedAt ?? null]);
}

test("a paused agent's running and waiting runs are stopped as Stop stops them, once: playbook_updated delivered while the agent is paused asks each one's stop and publishes one signals.run_stop_requested, whose delivery cancels its workflow; its scheduled run, an ended one, a source in no agent's and an active agent's runs stay as they are; a second delivery asks and publishes nothing", async () => {
  cancelled.length = 0;
  const workspaceId = "wsp_paused_agent";
  const sources = [];
  for (const label of ["Running", "Waiting", "Scheduled", "No agent", "Active agent"]) {
    sources.push(await createSignalSource({ workspaceId, label }));
  }
  const [s1, s2, s3, s4, s5] = sources.map(({ id }) => id) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const ownerUserId = "usr_owner";
  const paused = { workspaceId, icpId: "icp_paused", ownerUserId, status: "paused" as const };
  const agent = await createPlaybook({ ...paused, sourceIds: [s1, s2, s3] });
  await createPlaybook({ workspaceId, icpId: "icp_active", ownerUserId, sourceIds: [s5] });
  const run = (sourceId: string, status: "running" | "waiting" | "scheduled" | "done") =>
    createSignalRun({ workspaceId, sourceId, status, startedAt });
  const r1 = await run(s1, "running");
  const r2 = await run(s2, "waiting");
  const kept = [await run(s3, "scheduled"), await run(s1, "done")];
  kept.push(await run(s4, "running"), await run(s5, "waiting"));

  await updated(workspaceId, agent, "paused");
  await deliver();
  await deliver();
  const stops = [r1, r2].map(({ id, sourceId }) => ({ source_id: sourceId, run_id: id }));
  assert.deepEqual(
    await published(workspaceId, STOP),
    stops.sort((a, b) => a.run_id.localeCompare(b.run_id)),
  );
  assert.deepEqual(
    cancelled.sort(),
    [r1, r2].map(({ id }) => runNowWorkflowIdOf(workspaceId, id)).sort(),
  );
  const asked = await runs([r1.id, r2.id]);
  assert.deepEqual(
    asked.map(([status]) => status),
    ["running", "waiting"],
  );
  assert.ok(
    asked.every(([, at]) => at instanceof Date),
    "a stop was not asked",
  );
  const statuses = kept.map(({ status }) => [status, null]);
  assert.deepEqual(await runs(kept.map(({ id }) => id)), statuses);

  // At least once: the same event delivered again finds the stops asked.
  await updated(workspaceId, agent, "paused");
  await deliver();
  await deliver();
  assert.equal((await published(workspaceId, STOP)).length, 2);
  assert.equal(cancelled.length, 2);
  assert.deepEqual(await runs([r1.id, r2.id]), asked);
});

test("an agent paused for its owner's removal stops its sources' open runs the same way; an agent active when the event is delivered stops nothing, and starts nothing", async () => {
  cancelled.length = 0;
  const workspaceId = "wsp_removed_owner";
  const leaving = await createSignalSource({ workspaceId, label: "The leaver's" });
  const staying = await createSignalSource({ workspaceId, label: "A teammate's" });
  const ofLeaver = { workspaceId, icpId: "icp_leaver", ownerUserId: "usr_leaver" };
  await createPlaybook({ ...ofLeaver, sourceIds: [leaving.id] });
  const ofTeammate = { workspaceId, icpId: "icp_teammate", ownerUserId: "usr_teammate" };
  const teammates = await createPlaybook({ ...ofTeammate, sourceIds: [staying.id] });
  const waiting = await createSignalRun({ workspaceId, sourceId: leaving.id, status: "waiting" });
  const running = await createSignalRun({ workspaceId, sourceId: staying.id, status: "running" });

  assert.equal(await inRun(workspaceId, () => pauseRemovedMember("usr_leaver")), 1);
  await deliver();
  await deliver();
  const stop = { source_id: leaving.id, run_id: waiting.id };
  assert.deepEqual(await published(workspaceId, STOP), [stop]);
  assert.deepEqual(cancelled, [runNowWorkflowIdOf(workspaceId, waiting.id)]);

  // A resume or a rename publishes playbook_updated too: delivered while the agent is active.
  await updated(workspaceId, teammates, "active");
  await deliver();
  assert.deepEqual(await published(workspaceId, STOP), [stop]);
  assert.deepEqual(await runs([running.id]), [["running", null]]);
  assert.deepEqual(await published(workspaceId, "signals.run_requested"), []);
});

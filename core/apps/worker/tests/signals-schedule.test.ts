// signals' schedules and its run by hand through the worker host (alpha-p8-020;
// core/modules/signals/README.md "Runs"), on the slice's Temporal and a schema of its database: the
// host started with signals, whose subscribers, fed by the outbox loop, keep a source's schedule
// `signals-<sourceId>` through the scheduler the host binds and start a run by hand through its
// starter. The sources' sender account is disconnected, so each run the test causes ends at once,
// failed, before any read. Before a host binds it, createSchedule is workflows_not_bound, as in the
// api. The schedules a test made are deleted after it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ScheduleNotFoundError, WorkflowNotFoundError } from "@temporalio/client";
import { outboxWriter, type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  collectLogs,
  createLogger,
  createSchedule,
  newId,
  publish,
  servicePrincipal,
} from "@whytide/platform";
import { moduleLoaders } from "../src/modules.generated.ts";
import { start } from "../src/start.ts";
import { withTestWorkflowEnvironment } from "../testing/index.ts";

// signals' commands and events and linkedin's test hooks by their builds' paths, the files the
// worker's loader imports: the worker depends on neither module.
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
type Sources = typeof import("../../../modules/signals/dist/domain/sources.js");
type Events = typeof import("../../../modules/signals/dist/events.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const sources: Sources = await built("signals/dist/domain/sources.js");
const { events }: Events = await built("signals/dist/events.js");
const linkedin: LinkedinTesting = await built("linkedin/dist/testing/index.js");
type RunResult = { runId: string; status: string; code?: string };

withTestDb();
const env = withTestWorkflowEnvironment();
const db = () => asRole("app");
linkedin.useLinkedinClient(db());
const log = createLogger({ destination: collectLogs().destination });
const DAY_MS = 86_400_000;
const DISCONNECTED = { status: "failed", code: "linkedin_account_disconnected" };

const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal: servicePrincipal("test") }, fn, { client: db() });
/** What `read` answers once it answers something, within thirty seconds. */
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, "until: nothing within thirty seconds");
    await sleep(50);
  }
}
/** `promise`'s value, or undefined when it rejects with an error of `type`. */
const unless = <T>(promise: Promise<T>, type: new (...args: never[]) => Error) =>
  promise.catch((error: unknown) => {
    if (error instanceof type) return undefined;
    throw error;
  });

test("createSchedule is workflows_not_bound until a worker host binds its scheduler", async () => {
  const input = { workspaceId: "wsp_none", sourceId: "src_none" };
  const schedule = { scheduleId: "signals-src_none", workflow: "signals_run", input, at: [] };
  await assert.rejects(createSchedule(schedule), { code: "workflows_not_bound", status: 500 });
});

test("through the host: a new source's schedule has its three times and runs once now; disabling the source pauses it, deleting deletes it; a run by hand starts signals.run:<workspace>:<run>, and a second delivery starts none", async () => {
  const taskQueue = `test-${randomUUID()}`;
  const modules = moduleLoaders.filter(({ name }) => name === "signals");
  const host = await start({
    modules,
    taskQueue,
    healthPort: 0,
    client: db(),
    log,
    schedules: "off",
  });
  const made: string[] = [];
  try {
    const workspaceId = newId("wsp");
    const account = await linkedin.createConnectedAccount(workspaceId);
    const disconnected = { status: "disconnected" as const };
    await db().senderAccount.update({ where: { id: account.id }, data: disconnected });
    const newSource = {
      kind: "post_engagers",
      config: {
        postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000",
      },
      label: "Launch post",
      senderAccountId: account.id,
    };
    const source = await inRun(workspaceId, () => sources.createSource(newSource));
    const schedule = env.client.schedule.getHandle(`signals-${source.id}`);
    made.push(schedule.scheduleId);
    const described = await until(async () => {
      const found = await unless(schedule.describe(), ScheduleNotFoundError);
      return found && found.info.recentActions.length > 0 ? found : undefined;
    });
    const savedAt = Math.floor(source.createdAt.getTime() / 1000) * 1000;
    assert.equal(described.spec.calendars?.length, 3);
    assert.deepEqual(
      described.info.nextActionTimes.map((at) => at.getTime()),
      [savedAt + 3 * DAY_MS, savedAt + 7 * DAY_MS],
    );
    assert.equal(described.state.paused, false);
    assert.equal(described.action.type, "startWorkflow");
    assert.deepEqual(
      [described.action.workflowType, described.action.taskQueue, described.action.args],
      ["signals_run", taskQueue, [{ workspaceId, sourceId: source.id }]],
    );
    const now = described.info.recentActions[0]?.action.workflow;
    assert.ok(now !== undefined && now.workflowId.startsWith(`signals-${source.id}`));
    const first = env.client.workflow.getHandle(now.workflowId, now.firstExecutionRunId);
    const ran = await first.result();
    assert.deepEqual(ran, { runId: ran.runId, ...DISCONNECTED });
    const row = await db().signalRun.findUniqueOrThrow({ where: { id: ran.runId } });
    assert.deepEqual(
      [row.sourceId, row.status, row.error],
      [source.id, ...Object.values(DISCONNECTED)],
    );

    await inRun(workspaceId, () => sources.updateSource(source.id, { enabled: false }));
    await until(async () => ((await schedule.describe()).state.paused ? true : undefined));
    await inRun(workspaceId, () => sources.deleteSource(source.id));
    await until(async () =>
      (await unless(schedule.describe(), ScheduleNotFoundError)) ? undefined : true,
    );

    const other = await inRun(workspaceId, () => sources.createSource(newSource));
    made.push(`signals-${other.id}`);
    const requested = await inRun(workspaceId, () => sources.requestRun(other.id));
    assert.equal(requested.status, "scheduled");
    const byHand = env.client.workflow.getHandle<() => Promise<RunResult>>(
      `signals.run:${workspaceId}:${requested.id}`,
    );
    const ended = await until(() => unless(byHand.result(), WorkflowNotFoundError));
    assert.deepEqual(ended, { runId: requested.id, ...DISCONNECTED });
    const { runId } = await byHand.describe();
    const payload = { source_id: other.id, run_id: requested.id };
    const name = events["signals.run_requested"];
    const again = await inRun(workspaceId, (tx) =>
      publish(outboxWriter(tx, workspaceId), name, payload),
    );
    const delivered = await until(async () => {
      const entry = await db().outboxEntry.findUniqueOrThrow({ where: { id: again } });
      return entry.deliveredAt === null && entry.lastError === null ? undefined : entry;
    });
    assert.deepEqual([delivered.lastError, (await byHand.describe()).runId], [null, runId]);
  } finally {
    await host.close();
    for (const id of made)
      await unless(env.client.schedule.getHandle(id).delete(), ScheduleNotFoundError);
  }
});

test("through the host: enabling a source that has no schedule (saved before its schedules) creates it, unpaused, with its three times and no run now when it ran after the first", async () => {
  const taskQueue = `test-${randomUUID()}`;
  const modules = moduleLoaders.filter(({ name }) => name === "signals");
  const host = await start({
    modules,
    taskQueue,
    healthPort: 0,
    client: db(),
    log,
    schedules: "off",
  });
  const made: string[] = [];
  try {
    const workspaceId = newId("wsp");
    const account = await linkedin.createConnectedAccount(workspaceId);
    const savedAt = Math.floor((Date.now() - 60_000) / 1000) * 1000;
    const source = await db().signalSource.create({
      data: {
        id: newId("src"),
        workspaceId,
        kind: "post_engagers",
        config: {
          postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000001",
        },
        label: "Old post",
        senderAccountId: account.id,
        enabled: false,
        createdBy: "usr_test",
        createdAt: new Date(savedAt),
        lastRunAt: new Date(),
      },
    });
    const schedule = env.client.schedule.getHandle(`signals-${source.id}`);
    made.push(schedule.scheduleId);
    await inRun(workspaceId, () => sources.updateSource(source.id, { enabled: true }));
    const described = await until(() => unless(schedule.describe(), ScheduleNotFoundError));
    assert.equal(described.spec.calendars?.length, 3);
    assert.equal(described.state.paused, false);
    assert.deepEqual(
      described.info.nextActionTimes.map((at) => at.getTime()),
      [savedAt + 3 * DAY_MS, savedAt + 7 * DAY_MS],
    );
    assert.deepEqual(described.info.recentActions, []);
  } finally {
    await host.close();
    for (const id of made)
      await unless(env.client.schedule.getHandle(id).delete(), ScheduleNotFoundError);
  }
});

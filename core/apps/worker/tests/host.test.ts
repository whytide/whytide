// The worker host end to end (README "Start"), on the slice's Temporal and a schema of its database:
// the fixture module's workflow runs through the worker, its activity in a tenant run for the
// input's workspace, and its global workflow's activity in none, with no workspace on its line; an
// outbox row published through the platform reaches the fixture's subscriber, and once the
// subscriber of a second module that imports the first's events through its index; a subscriber's
// startWorkflow starts one run for an event delivered twice; the schedules, a global one's too, are
// upserted by their ids, paused with WORKER_SCHEDULES=off; GET /health answers ok, and 503 once
// Temporal is out of reach behind a TCP proxy the test closes. The log lines meet the schema.
// A failing activity fails its workflow, and the metrics count both by name and code (alpha-p10-060).
// cancelWorkflow cancels fixture_hold, started under a known id, which its activity saw in its
// context: its cancellation handler runs and it ends cancelled; an unknown or a closed id answers
// `{ cancelled: false }`. The fixture module's `alerts` is read at start: its event, delivered,
// reaches the alerts fake with its id; a module naming an unknown event stops the start (gamma-p7-040).
// A run queued before the start, its one attempt of an activity calling startWorkflow, cancelWorkflow
// and pauseSchedule, finds them bound: the host binds them before the worker polls.
// The fixture modules load from their build, dist/tests/fixtures, as the worker loads a module's.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { outboxWriter, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  cancelWorkflow,
  checkLogLines,
  collectLogs,
  createLogger,
  DEFAULT_TASK_QUEUE,
  defineWorkflows,
  type LogSchema,
  logSchema,
  outboxConfig,
  publish,
  recordedMetrics,
  servicePrincipal,
  workflowInput,
} from "@whytide/platform";
import { type AlertsFake, alertsPort, getAdapter } from "@whytide/providers";
import { workerConfig } from "../src/config.ts";
import type { ModuleLoader } from "../src/modules.ts";
import { type StartOptions, start, type WorkerHost } from "../src/start.ts";

withTestDb({ fixtures: ["20261021000800_db_test_tenant_settings"] });
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const fixtures = join(import.meta.dirname, "..", "dist", "tests", "fixtures");
const built = (path: string) => import(pathToFileURL(join(fixtures, path)).href);
// The second module first, as a module that subscribes to another's events may come before it.
const subscriber: typeof import("./fixtures/subscriber/events.ts") =
  await built("subscriber/events.js");
const { events, received, starts }: typeof import("./fixtures/module/events.ts") =
  await built("module/events.js");
const { held }: typeof import("./fixtures/module/workflows/index.ts") = await built(
  "module/workflows/index.js",
);
const modules: ModuleLoader[] = [
  { name: "subscriber", events: () => built("subscriber/events.js") },
  {
    name: "fixture",
    events: () => built("module/events.js"),
    workflows: () => built("module/workflows/index.js"),
  },
];
const options = (more: StartOptions = {}): StartOptions => ({
  modules,
  workflowsPath: join(fixtures, "workflows.js"),
  taskQueue: `test-${randomUUID()}`,
  healthPort: 0,
  client: asRole("app"),
  alerts: "fake",
  log,
  ...more,
});
const CROWD = 250;
const channel = (await getAdapter(alertsPort, "fake")) as unknown as AlertsFake;

/** A TCP proxy to the slice's Temporal: closing it puts Temporal out of the worker's reach. */
function temporalProxy() {
  const [host = "", port = ""] = workerConfig.TEMPORAL_ADDRESS.split(/:(?=\d+$)/);
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  const proxy = {
    port: 0,
    async open() {
      server = createServer((inbound) => {
        const outbound = connect(Number(port), host);
        for (const socket of [inbound, outbound]) {
          sockets.add(socket);
          socket.on("error", () => socket.destroy()).once("close", () => sockets.delete(socket));
        }
        inbound.pipe(outbound).pipe(inbound);
      });
      await new Promise<void>((resolve) => server?.listen(proxy.port, "127.0.0.1", resolve));
      proxy.port = (server.address() as AddressInfo).port;
    },
    async close() {
      const closed = new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
  return proxy;
}

const proxy = temporalProxy();
let host: WorkerHost;
let temporal: Client;

before(async () => {
  await proxy.open();
  host = await start(options({ address: `127.0.0.1:${proxy.port}`, schedules: "off" }));
  const connection = await Connection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  temporal = new Client({ connection, namespace: workerConfig.TEMPORAL_NAMESPACE });
});
after(async () => {
  await host?.close();
  await proxy.close();
  await temporal?.connection.close();
});

test("a fixture workflow runs through the worker, its activity in a tenant run for its workspace", async () => {
  const workspaceId = `ws_${randomUUID()}`;
  const result = await temporal.workflow.execute("fixture_echo", {
    args: [{ workspaceId }],
    taskQueue: host.taskQueue,
    workflowId: `fixture-echo-${randomUUID()}`,
    workflowExecutionTimeout: "1 minute",
  });
  assert.deepEqual(result, { workspaceId, setting: workspaceId, actor: "service:worker" });
});

test("a global workflow runs through the worker, its activity with no tenant run, no tenant in its context and no workspace_id on its line", async () => {
  const result = await temporal.workflow.execute("fixture_global", {
    args: [{}],
    taskQueue: host.taskQueue,
    workflowId: `fixture-global-${randomUUID()}`,
    workflowExecutionTimeout: "1 minute",
  });
  assert.deepEqual(result, { context: ["attempt"], scope: null });
  const ran = logs.lines().filter(({ msg }) => msg === "fixture: a global activity ran");
  assert.equal(ran.length, 1);
  assert.equal(ran[0]?.actor, "service:worker");
  assert.equal(ran[0] && "workspace_id" in ran[0], false);
});

test("a failing activity fails its workflow; the metrics count both by name and code", async () => {
  const run = temporal.workflow.execute("fixture_echo", {
    args: [{ workspaceId: "" }],
    taskQueue: host.taskQueue,
    workflowId: `fixture-echo-${randomUUID()}`,
    workflowExecutionTimeout: "1 minute",
  });
  await assert.rejects(run);
  const runs = () => recordedMetrics().get("worker.workflow.runs") ?? [];
  const failed = () => runs().find(({ outcome }) => outcome === "failed");
  const deadline = Date.now() + 5_000;
  while (!failed() && Date.now() < deadline) await sleep(20);
  assert.deepEqual(failed(), { workflow: "fixture_echo", outcome: "failed" });
  assert.deepEqual(recordedMetrics().get("worker.activity.failures"), [
    { activity: "fixture_tenant", code: "activity_input_invalid" },
  ]);
});

test("an outbox row published through the platform is delivered within two poll intervals", async () => {
  const workspaceId = `ws_${randomUUID()}`;
  const tenant = { workspaceId, principal: servicePrincipal("test") };
  const started = Date.now();
  const id = await withTenant(
    tenant,
    (tx) => publish(outboxWriter(tx, workspaceId), events["fixture.pinged"], { ping_id: "p_1" }),
    { client: asRole("app") },
  );
  const limit = 2 * outboxConfig.OUTBOX_POLL_MS;
  while (!received.includes(id) && Date.now() - started < 2 * limit) await sleep(20);
  const elapsed = Date.now() - started;
  assert.ok(received.includes(id), "the event was never delivered");
  assert.ok(elapsed <= limit, `delivered after ${elapsed} ms, past ${limit} ms`);
});

test("a module subscribed to another's event through its index is delivered it once", async () => {
  const workspaceId = `ws_${randomUUID()}`;
  const tenant = { workspaceId, principal: servicePrincipal("test") };
  const id = await withTenant(
    tenant,
    (tx) => publish(outboxWriter(tx, workspaceId), events["fixture.pinged"], { ping_id: "p_2" }),
    { client: asRole("app") },
  );
  const deadline = Date.now() + 4 * outboxConfig.OUTBOX_POLL_MS;
  while (!subscriber.received.includes(id) && Date.now() < deadline) await sleep(20);
  await sleep(2 * outboxConfig.OUTBOX_POLL_MS); // time for a second delivery, if there were one
  const deliveries = (list: readonly string[]) => list.filter((each) => each === id);
  assert.deepEqual(deliveries(subscriber.received), [id]);
  assert.deepEqual(deliveries(received), [id]);
});

test("a subscriber's startWorkflow starts one run for an event delivered twice, by its id", async () => {
  const workspaceId = `ws_${randomUUID()}`;
  const tenant = { workspaceId, principal: servicePrincipal("test") };
  const request = { request_id: "r_1" };
  const id = await withTenant(
    tenant,
    (tx) => publish(outboxWriter(tx, workspaceId), events["fixture.requested"], request),
    { client: asRole("app") },
  );
  const answers = () => starts.filter((each) => each.id === id).map(({ started }) => started);
  const deadline = Date.now() + 10 * outboxConfig.OUTBOX_POLL_MS;
  while (answers().length < 2 && Date.now() < deadline) await sleep(20);
  assert.deepEqual(answers(), [true, false]);
  const run = temporal.workflow.getHandle(`fixture.echo:${workspaceId}:r_1`);
  const echo = { workspaceId, setting: workspaceId, actor: "service:worker" };
  assert.deepEqual(await run.result(), echo);
});

test("cancelWorkflow cancels an open workflow by its id: its cancellation handler runs and it ends cancelled; its activity saw that id in context.workflowId", async () => {
  const workspaceId = `ws_${randomUUID()}`;
  const workflowId = `fixture.hold:${workspaceId}`;
  const handle = await temporal.workflow.start("fixture_hold", {
    args: [{ workspaceId }],
    taskQueue: host.taskQueue,
    workflowId,
    workflowExecutionTimeout: "1 minute",
  });
  const steps = () => held.filter((each) => each.workspaceId === workspaceId);
  const deadline = Date.now() + 10_000;
  while (steps().length === 0 && Date.now() < deadline) await sleep(20);
  assert.deepEqual(steps(), [{ workspaceId, step: "started", workflowId }]);
  assert.deepEqual(await cancelWorkflow({ workflowId }), { cancelled: true });
  await assert.rejects(handle.result(), { message: "Workflow execution cancelled" });
  assert.deepEqual(steps(), [
    { workspaceId, step: "started", workflowId },
    { workspaceId, step: "cancelled", workflowId },
  ]);
});

test("cancelWorkflow answers { cancelled: false } for an id no workflow has and for a closed workflow's", async () => {
  const workflowId = `fixture-echo-${randomUUID()}`;
  await temporal.workflow.execute("fixture_echo", {
    args: [{ workspaceId: `ws_${randomUUID()}` }],
    taskQueue: host.taskQueue,
    workflowId,
    workflowExecutionTimeout: "1 minute",
  });
  assert.deepEqual(await cancelWorkflow({ workflowId }), { cancelled: false });
  const unknown = `fixture.hold:ws_${randomUUID()}`;
  assert.deepEqual(await cancelWorkflow({ workflowId: unknown }), { cancelled: false });
});

test("the starter, the canceller and the scheduler are bound before the worker polls: a run queued before the start calls them on its one attempt", async () => {
  // The bindings are the process's, so the file's own host steps aside, then starts again.
  await host.close();
  const workspaceId = `ws_${randomUUID()}`;
  const taskQueue = `test-${randomUUID()}`;
  // As many schedules as the real host upserts: the start spends its time there, which, before the
  // binds, was the gap in which a run waiting on the queue found nothing bound.
  const crowd = Array.from({ length: CROWD }, (_, index) => `crowd_${index}`);
  const crowded: ModuleLoader = {
    name: "crowd",
    workflows: async () => ({
      workflows: defineWorkflows({
        crowd_tick: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
      }),
      schedules: crowd.map((id) => ({
        id,
        workflow: "crowd_tick",
        spec: { intervals: [{ every: "365 days" }] },
        input: { workspaceId: "ws_fixture" },
      })),
    }),
  };
  const queued = await temporal.workflow.start("fixture_binds", {
    args: [{ workspaceId }],
    taskQueue,
    workflowId: `fixture.binds-run:${workspaceId}`,
    workflowExecutionTimeout: "1 minute",
  });
  let second: WorkerHost | undefined;
  try {
    second = await start(options({ taskQueue, schedules: "off", modules: [...modules, crowded] }));
    assert.deepEqual(await queued.result(), { started: true, found: false });
  } finally {
    await second?.close();
    await Promise.all(
      crowd.map((id) =>
        temporal.schedule
          .getHandle(`crowd.${id}`)
          .delete()
          .catch(() => undefined),
      ),
    );
    host = await start(options({ address: `127.0.0.1:${proxy.port}`, schedules: "off" }));
  }
});

test("the schedules are created at start by their ids, a global one's too, never twice, and paused with WORKER_SCHEDULES=off", async () => {
  const handle = temporal.schedule.getHandle("fixture.tick");
  const global = temporal.schedule.getHandle("fixture.global_tick");
  const restart = async (schedules: "on" | "off") => (await start(options({ schedules }))).close();
  const clear = () => Promise.all([handle, global].map((h) => h.delete().catch(() => undefined)));
  await clear();
  try {
    await restart("on");
    const created = await handle.describe();
    assert.equal(created.state.paused, false);
    const createdGlobal = await global.describe();
    assert.equal(createdGlobal.action.workflowType, "fixture_global");
    await restart("on");
    assert.deepEqual((await handle.describe()).info.createdAt, created.info.createdAt);
    assert.deepEqual((await global.describe()).info.createdAt, createdGlobal.info.createdAt);
    await restart("off");
    assert.equal((await handle.describe()).state.paused, true);
  } finally {
    await clear();
  }
});

test("the modules' alerts are read at start: the fixture's event, delivered, reaches the team channel with its id; a module naming an unknown event stops the start with worker_module_invalid", async () => {
  const workspaceId = `ws_${randomUUID()}`;
  const tenant = { workspaceId, principal: servicePrincipal("test") };
  const pingId = "png_01JAB3K5ZQ7W9R2M4T6V8X0Y1C";
  await withTenant(
    tenant,
    (tx) => publish(outboxWriter(tx, workspaceId), events["fixture.pinged"], { ping_id: pingId }),
    { client: asRole("app") },
  );
  const text = `[test] event fixture.pinged ping_id=${pingId}`;
  const deadline = Date.now() + 10 * outboxConfig.OUTBOX_POLL_MS;
  while (!channel.sent().includes(text) && Date.now() < deadline) await sleep(20);
  assert.ok(channel.sent().includes(text), "the alert never reached the channel");

  const unknown = { name: "probe", workflows: async () => ({ alerts: ["probe.missing"] }) };
  const details = { module: "probe", field: "alerts", event: "probe.missing" };
  await assert.rejects(start(options({ modules: [unknown] })), {
    code: "worker_module_invalid",
    details,
  });
});

test("GET /health reports ok with the namespace and the workflow count, 503 once Temporal is out of reach", async () => {
  const ok = await fetch(host.healthUrl);
  const body = (await ok.json()) as Record<string, unknown>;
  assert.equal(ok.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.namespace, workerConfig.TEMPORAL_NAMESPACE);
  assert.equal(body.workflow_count, 5);
  assert.equal(typeof body.last_poll_at, "string");
  await proxy.close();
  try {
    const down = await fetch(host.healthUrl);
    assert.equal(down.status, 503);
    assert.equal(((await down.json()) as Record<string, unknown>).temporal, "unreachable");
  } finally {
    await proxy.open();
  }
});

test("the host's log lines carry the schema's keys only", () => {
  const path = join(import.meta.dirname, "..", "log-schema.json");
  const own = JSON.parse(readFileSync(path, "utf8")) as LogSchema;
  const schema = { keys: [...logSchema.keys, ...own.keys], suffixes: logSchema.suffixes };
  const lines = logs.raw.join("").split("\n").filter(Boolean);
  assert.ok(lines.length > 0);
  assert.deepEqual(checkLogLines(lines, schema), []);
});

// start() (README "Start"): the modules and their onWorkerStart, the agents, the Temporal connection,
// the starter of startWorkflow (starter.ts), the canceller of cancelWorkflow (canceller.ts) and the
// scheduler of a row's schedule (scheduler.ts), bound before the worker polls, then one worker on one
// task queue, the schedules, the outbox loop, GET /health and the gauges (metrics.ts), set at start
// and every 15 seconds. The alert queue (alerts.ts) binds right after the modules, with their alert
// events, so that it takes the activities', the workflows' and the outbox's alerts from the first.
// close() undoes them in reverse: the gauges, the health server and the outbox loop first, then the
// worker once its activities settled, then the scheduler, the canceller and the starter, which an
// activity still finishing may call until then, then Mastra, the database clients and the alert
// queue. A failed start is logged with its code, undone and thrown.
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createDbClient, disconnectTenantClient, type PrismaClient } from "@whytide/db";
import {
  bindWorkflowCanceller,
  bindWorkflowScheduler,
  bindWorkflowStarter,
  createLogger,
  DEFAULT_TASK_QUEUE,
  type Logger,
} from "@whytide/platform";
import { hostActivity } from "./activities.ts";
import { startAgents } from "./agents.ts";
import { startAlerts, subscribeAlerts } from "./alerts.ts";
import { workflowCanceller } from "./canceller.ts";
import { workerConfig } from "./config.ts";
import { type HealthReport, startHealth } from "./health.ts";
import { workerMetrics } from "./metrics.ts";
import { moduleLoaders } from "./modules.generated.ts";
import { loadModules, type ModuleLoader, startModules } from "./modules.ts";
import { startOutboxLoop } from "./outbox.ts";
import { workflowScheduler } from "./scheduler.ts";
import { upsertSchedules } from "./schedules.ts";
import { workflowStarter } from "./starter.ts";
import {
  generatedWorkflows,
  IDENTITY,
  installRuntime,
  metricSinks,
  workflowBundle,
} from "./temporal.ts";

const GAUGES_MS = 15_000;

export type StartOptions = {
  /** The generated list by default. */
  readonly modules?: readonly ModuleLoader[];
  /** The bundle's entry: src/workflows.generated.ts by default. */
  readonly workflowsPath?: string;
  /** DEFAULT_TASK_QUEUE by default; a test's own. */
  readonly taskQueue?: string;
  /** TEMPORAL_ADDRESS by default. */
  readonly address?: string;
  /** WORKER_HEALTH_PORT by default; 0 picks a free one. */
  readonly healthPort?: number;
  /** WORKER_SCHEDULES by default. */
  readonly schedules?: "on" | "off";
  /** The alerts adapter, PROVIDER_ALERTS by default; empty for no team channel. */
  readonly alerts?: string;
  /** The `app` client of the tenant runs, kept open by the caller; the host's own by default. */
  readonly client?: PrismaClient;
  readonly log?: Logger;
};
export type WorkerHost = {
  readonly healthUrl: string;
  readonly taskQueue: string;
  /** Settles when the worker stops, rejected when it failed. */
  readonly done: Promise<void>;
  close(): Promise<void>;
};

export async function start(options: StartOptions = {}): Promise<WorkerHost> {
  const log = options.log ?? createLogger();
  const namespace = workerConfig.TEMPORAL_NAMESPACE;
  const taskQueue = options.taskQueue ?? DEFAULT_TASK_QUEUE;
  const undo: (() => Promise<unknown>)[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      for (const step of undo.reverse()) {
        await step().catch((error: unknown) => log.error({ err: error }, "worker: a stop failed"));
      }
    })());
  try {
    installRuntime();
    const modules = await loadModules(options.modules ?? moduleLoaders);
    await startModules(modules, log);
    const alerts = await startAlerts({ log, selector: options.alerts });
    undo.push(() => alerts.stop());
    subscribeAlerts(modules.alerts);
    const client = options.client ?? createDbClient("app");
    undo.push(() => (options.client ? Promise.resolve() : client.$disconnect()));
    undo.push(disconnectTenantClient);
    const mastra = await startAgents(client);
    undo.push(() => mastra.shutdown());
    const address = options.address ?? workerConfig.TEMPORAL_ADDRESS;
    const connection = await NativeConnection.connect({ address });
    undo.push(() => connection.close());
    const activities = Object.fromEntries(
      [...modules.activities].map(([name, definition]) => {
        return [name, hostActivity(name, definition, { client, log })];
      }),
    );
    // Bound before the worker polls: a run that waited on the queue while the host was down is
    // taken at once, and its activity may call startWorkflow, cancelWorkflow or the scheduler. Their
    // undo is pushed before the worker's, so that close() runs it after the worker has stopped.
    const temporal = new Client({ connection, namespace, identity: IDENTITY });
    const unbind = bindWorkflowStarter(workflowStarter(temporal, modules.workflows, taskQueue));
    undo.push(async () => unbind());
    const unbindCanceller = bindWorkflowCanceller(workflowCanceller(temporal));
    undo.push(async () => unbindCanceller());
    const scheduler = workflowScheduler(temporal, modules.workflows, taskQueue);
    const unbindScheduler = bindWorkflowScheduler(scheduler);
    undo.push(async () => unbindScheduler());
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      identity: IDENTITY,
      workflowBundle: await workflowBundle(options.workflowsPath ?? generatedWorkflows),
      activities,
      sinks: metricSinks(log),
    });
    const done = worker.run();
    done.catch((error: unknown) => log.fatal({ err: error }, "worker: the worker failed"));
    undo.push(async () => {
      if (worker.getState() === "RUNNING") worker.shutdown();
      await done.catch(() => undefined);
    });
    const paused = (options.schedules ?? workerConfig.WORKER_SCHEDULES) === "off";
    await upsertSchedules(temporal, modules.schedules, { taskQueue, paused });
    const outbox = startOutboxLoop(client, log);
    undo.push(() => outbox.stop());
    const report = async (): Promise<HealthReport> => {
      // The SDK retries a call that fails to connect, past any deadline: the race bounds it.
      const describe = () => connection.workflowService.describeNamespace({ namespace });
      const reach = await Promise.race([
        connection.withDeadline(Date.now() + 2_000, describe).then(
          () => "connected" as const,
          () => "unreachable" as const,
        ),
        sleep(2_000, "unreachable" as const, { ref: false }),
      ]);
      const state = worker.getState();
      const ok = reach === "connected" && state === "RUNNING";
      workerMetrics["worker.health"].record(ok ? 1 : 0, {});
      return {
        status: ok ? "ok" : "failing",
        namespace,
        task_queue: taskQueue,
        workflow_count: modules.workflows.size,
        temporal: reach,
        worker: state,
        last_poll_at: outbox.lastPollAt()?.toISOString() ?? null,
      };
    };
    const health = await startHealth(options.healthPort ?? workerConfig.WORKER_HEALTH_PORT, report);
    undo.push(() => health.close());
    const gauges = () => Promise.all([report(), outbox.recordStats()]).catch(() => undefined);
    await gauges();
    const timer = setInterval(gauges, GAUGES_MS);
    undo.push(async () => clearInterval(timer));
    const counts = {
      workflow_count: modules.workflows.size,
      activity_count: modules.activities.size,
      schedule_count: modules.schedules.length,
    };
    log.info({ namespace, task_queue: taskQueue, ...counts }, "worker: started");
    return { healthUrl: health.url, taskQueue, done, close };
  } catch (error) {
    log.fatal({ err: error }, "worker: the start failed");
    await close();
    throw error;
  }
}

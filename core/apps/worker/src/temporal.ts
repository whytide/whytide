// The Temporal side of the host (README "Temporal"): the SDK's runtime, installed once per process
// with its warnings on pino, no metrics exporter and no signal handler of its own (main.ts stops the
// worker); the workflow bundle, built once per entry file with the metrics interceptor, and the sink
// that counts what it reports; one identity, so that no hostname reaches a history.
import { join } from "node:path";
import {
  bundleWorkflowCode,
  DefaultLogger,
  type InjectedSinks,
  type LogEntry,
  Runtime,
  type WorkflowBundle,
} from "@temporalio/worker";
import { createLogger } from "@whytide/platform";
import { workerMetrics } from "./metrics.ts";
import type { MetricsSinks } from "./workflow-interceptors.ts";

export const IDENTITY = "whytide-worker";
/** The bundle entry `pnpm -F worker modules:generate` writes: the smoke workflow and every module's. */
export const generatedWorkflows = join(import.meta.dirname, "workflows.generated.ts");
const interceptors = join(import.meta.dirname, "workflow-interceptors.ts");

let logger: DefaultLogger | undefined;
let installed = false;
const bundles = new Map<string, Promise<WorkflowBundle>>();

/** The SDK's warnings and errors as pino lines `temporal: <message>`, without its metadata. */
function temporalLogger(): DefaultLogger {
  if (logger) return logger;
  const log = createLogger();
  logger = new DefaultLogger("WARN", ({ level, message }: LogEntry) => {
    if (level === "ERROR") log.error(`temporal: ${message}`);
    else log.warn(`temporal: ${message}`);
  });
  return logger;
}

export function installRuntime(): void {
  if (installed) return;
  installed = true;
  Runtime.install({
    logger: temporalLogger(),
    telemetryOptions: { logging: { filter: { core: "WARN", other: "ERROR" }, forward: {} } },
    shutdownSignals: [],
  });
}

/** The bundle of a workflow entry file, made once per process. */
export function workflowBundle(workflowsPath: string): Promise<WorkflowBundle> {
  let bundle = bundles.get(workflowsPath);
  if (!bundle) {
    const workflowInterceptorModules = [interceptors];
    bundle = bundleWorkflowCode({
      workflowsPath,
      workflowInterceptorModules,
      logger: temporalLogger(),
    });
    bundles.set(workflowsPath, bundle);
  }
  return bundle;
}

/** The sink the interceptor reports to, for every worker of the bundle, a replaying one included. */
export function metricSinks(): InjectedSinks<MetricsSinks> {
  return {
    metrics: {
      started: {
        // Temporal sets TemporalScheduledById on a run a schedule started. The info is a structured
        // clone from the workflow thread: the typed attributes lost their methods, the plain ones not.
        fn: ({ workflowType: workflow, searchAttributes }) => {
          const trigger = searchAttributes?.TemporalScheduledById ? "schedule" : "start";
          workerMetrics["worker.workflow.starts"].add(1, { workflow, trigger });
        },
      },
      ended: {
        fn: ({ workflowType: workflow }, outcome) => {
          workerMetrics["worker.workflow.runs"].add(1, { workflow, outcome });
        },
      },
    },
  };
}

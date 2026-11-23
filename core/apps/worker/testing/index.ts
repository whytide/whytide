// The workflow test harness (README "Testing"; docs/workflows.md). It runs on the slice's Temporal
// (TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE), never on a downloaded test server, so there is no time
// skipping yet: keep a test's timers short. withTestWorkflowEnvironment(), once at the top of a test
// file, connects before its tests and closes after them, on a task queue of its own; runWorkflow
// runs one workflow there on a worker with the activities given, the host's sink logging to the log
// given; replayHistories needs no server.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { after, before } from "node:test";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { Logger } from "@whytide/platform";
import { workerConfig } from "../src/config.ts";
import {
  generatedWorkflows,
  IDENTITY,
  installRuntime,
  metricSinks,
  workflowBundle,
} from "../src/temporal.ts";

export type TestWorkflowEnvironment = {
  readonly namespace: string;
  readonly taskQueue: string;
  /** The workflow entry runWorkflow bundles: src/workflows.generated.ts by default. */
  readonly workflowsPath: string;
  readonly client: Client;
};
export type Activities = Record<string, (input: never) => Promise<unknown>>;

let current:
  | { readonly env: TestWorkflowEnvironment; readonly connection: NativeConnection }
  | undefined;

export function withTestWorkflowEnvironment(
  options: { readonly workflowsPath?: string } = {},
): TestWorkflowEnvironment {
  if (current) throw new Error("withTestWorkflowEnvironment() is called once per test file");
  const namespace = workerConfig.TEMPORAL_NAMESPACE;
  const workflowsPath = options.workflowsPath ?? generatedWorkflows;
  let client: Client | undefined;
  const env: TestWorkflowEnvironment = {
    namespace,
    taskQueue: `test-${randomUUID()}`,
    workflowsPath,
    get client() {
      if (!client) throw new Error("the environment connects in before()");
      return client;
    },
  };
  before(async () => {
    installRuntime();
    const connection = await NativeConnection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
    client = new Client({ connection, namespace, identity: IDENTITY });
    current = { env, connection };
  });
  after(async () => {
    await current?.connection.close();
    current = undefined;
  });
  return env;
}

/**
 * Runs workflow `name` to its end on a worker of the environment's queue, with `activities`; under
 * `workflowId`, for a test that reads or records its history, else `<name>-<uuid>`.
 */
export async function runWorkflow<T = unknown>(
  name: string,
  input: unknown,
  options: {
    readonly activities?: Activities;
    readonly log?: Logger;
    readonly workflowId?: string;
  } = {},
): Promise<T> {
  if (!current) throw new Error("runWorkflow() needs withTestWorkflowEnvironment() first");
  const { env, connection } = current;
  const worker = await Worker.create({
    connection,
    namespace: env.namespace,
    taskQueue: env.taskQueue,
    identity: IDENTITY,
    workflowBundle: await workflowBundle(env.workflowsPath),
    activities: options.activities ?? {},
    sinks: metricSinks(options.log),
  });
  const run = env.client.workflow.execute(name, {
    args: [input],
    taskQueue: env.taskQueue,
    workflowId: options.workflowId ?? `${name}-${randomUUID()}`,
    workflowExecutionTimeout: "1 minute",
  });
  return (await worker.runUntil(run)) as T;
}

/** Replays each history file against the bundle of `workflowsPath`; the first that fails throws. */
export async function replayHistories(
  workflowsPath: string,
  files: readonly string[],
): Promise<void> {
  // The SDK's runtime stops once its last worker does: one made for no worker keeps the process up.
  if (files.length === 0) return;
  installRuntime();
  const bundle = await workflowBundle(workflowsPath);
  for (const file of files) {
    const history: unknown = JSON.parse(readFileSync(file, "utf8"));
    const options = { workflowBundle: bundle, replayName: basename(file), sinks: metricSinks() };
    await Worker.runReplayHistory(options, history);
  }
}

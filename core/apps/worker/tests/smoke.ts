// `pnpm -F worker smoke` (README "Smoke"): starts worker_smoke, the no-op workflow, on the stack's
// Temporal and waits 30 seconds at most for a running worker to answer; exits 0 on its answer only.
// TEMPORAL_ADDRESS must be this machine's.
import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import { DEFAULT_TASK_QUEUE } from "@whytide/platform";
import { localTemporalAddress, workerConfig } from "../src/config.ts";

const connection = await Connection.connect({ address: localTemporalAddress() });
try {
  const namespace = workerConfig.TEMPORAL_NAMESPACE;
  const client = new Client({ connection, namespace, identity: "whytide-smoke" });
  const answer = await client.workflow.execute("worker_smoke", {
    taskQueue: DEFAULT_TASK_QUEUE,
    workflowId: `worker-smoke-${randomUUID()}`,
    workflowExecutionTimeout: "30 seconds",
  });
  process.stdout.write(`smoke: worker_smoke answered ${String(answer)} in ${namespace}\n`);
  process.exitCode = answer === "ok" ? 0 : 1;
} finally {
  await connection.close();
}

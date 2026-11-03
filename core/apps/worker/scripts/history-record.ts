// `pnpm -F worker history:record <workflowId> [file]` (docs/workflows.md "Recording a history"):
// saves the history of a workflow that ran on the stack's Temporal, as JSON, for test:replay. The
// file is core/modules/<module>/workflows/__histories__/<workflowId>.json, the module whose prefix
// the workflow's type carries, unless one is given. TEMPORAL_ADDRESS must be this machine's.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Client, Connection } from "@temporalio/client";
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";
import { localTemporalAddress, workerConfig } from "../src/config.ts";
import { listModules } from "./modules-generate.ts";

const [workflowId, given] = process.argv.slice(2);
if (!workflowId || !/^[\w.-]+$/.test(workflowId)) {
  process.stderr.write("usage: pnpm -F worker history:record <workflowId> [file]\n");
  process.exit(2);
}
const connection = await Connection.connect({ address: localTemporalAddress() });
try {
  const namespace = workerConfig.TEMPORAL_NAMESPACE;
  const client = new Client({ connection, namespace, identity: "whytide-history" });
  const history = await client.workflow.getHandle(workflowId).fetchHistory();
  const type = history.events?.[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name;
  const modules = join(import.meta.dirname, "..", "..", "..", "modules");
  const module = listModules(modules).find((name) => type?.startsWith(`${name}_`));
  const file = given
    ? resolve(process.env.INIT_CWD ?? process.cwd(), given)
    : module && join(modules, module, "workflows", "__histories__", `${workflowId}.json`);
  if (!file) throw new Error(`no module's prefix starts the workflow type ${type}: give a file`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(JSON.parse(historyToJSON(history)), null, 2)}\n`);
  process.stdout.write(`history:record: ${file}\n`);
} finally {
  await connection.close();
}

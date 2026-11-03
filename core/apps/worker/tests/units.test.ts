// Unit tests of the host's parts, without Temporal or the database: the generated list and bundle
// entry import the modules' builds; a missing build stops the start with worker_module_not_built,
// naming the file; a module's onWorkerStart runs with the host's logger, and credits' binds the
// credits client; an input that does not fit its scope stops the start; startWorkflow fails
// workflows_not_bound until a starter is bound, and the worker's refuses an unknown workflow or an
// input off its schema and sends what the schema declares; GET /health answers 503 when its report
// rejects.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  bindWorkflowStarter,
  collectLogs,
  createLogger,
  credits,
  DEFAULT_TASK_QUEUE,
  globalWorkflowInput,
  isAppError,
  type Logger,
  startWorkflow,
  workflowInput,
} from "@whytide/platform";
import { generatedSources } from "../scripts/modules-generate.ts";
import { startHealth } from "../src/health.ts";
import { moduleLoaders } from "../src/modules.generated.ts";
import { loadModules, startModules } from "../src/modules.ts";
import { workflowStarter } from "../src/starter.ts";

test("the generated list and bundle entry import each module's build, dist/", () => {
  const out = join(import.meta.dirname, "..", "src");
  const { modules, workflows } = generatedSources(join(import.meta.dirname, "fixtures"), out);
  for (const file of [
    "module/dist/events.js",
    "module/dist/workflows/index.js",
    "subscriber/dist/events.js",
  ]) {
    assert.ok(modules.includes(`load("../tests/fixtures/${file}")`), file);
  }
  assert.ok(
    workflows.includes('export * from "../tests/fixtures/module/dist/workflows/workflows.js";'),
  );
  assert.doesNotMatch(`${modules}${workflows}`, /fixtures\/[^"]*\.ts"/);
});

test("a module whose build is missing stops the start with worker_module_not_built", async () => {
  const missing = join(import.meta.dirname, "..", ".tmp", "unbuilt", "dist", "events.js");
  const loader = { name: "unbuilt", events: () => import(pathToFileURL(missing).href) };
  await assert.rejects(loadModules([loader]), (error: unknown) => {
    assert.ok(isAppError(error));
    assert.equal(error.code, "worker_module_not_built");
    const details = { module: "unbuilt", missing: "core/apps/worker/.tmp/unbuilt/dist/events.js" };
    assert.deepEqual(error.details, details);
    return true;
  });
});

test("a global workflow or activity whose input declares workspaceId, or a workspace one without it, is worker_module_invalid naming it", async () => {
  const taskQueue = DEFAULT_TASK_QUEUE;
  const run = async () => undefined;
  const global = { input: workflowInput, scope: "global" };
  const plain = { input: globalWorkflowInput };
  const declared = {
    "workflows.probe_global": { workflows: { probe_global: { ...global, taskQueue } } },
    "workflows.probe_plain": { workflows: { probe_plain: { ...plain, taskQueue } } },
    "activities.probe_global": { activities: { probe_global: { ...global, kind: "db", run } } },
    "activities.probe_plain": { activities: { probe_plain: { ...plain, kind: "db", run } } },
  };
  for (const [field, exports] of Object.entries(declared)) {
    const loader = { name: "probe", workflows: async () => exports };
    const invalid = { code: "worker_module_invalid", details: { module: "probe", field } };
    await assert.rejects(loadModules([loader]), invalid);
  }
});

test("startWorkflow is workflows_not_bound until the worker binds its starter, which refuses an unknown workflow or an input off its schema, and sends oneAtATime as ALLOW_DUPLICATE", async () => {
  const request = { workflow: "probe_echo", input: { workspaceId: "ws_1" }, workflowId: "probe:1" };
  const notBound = { code: "workflows_not_bound", status: 500 };
  await assert.rejects(startWorkflow(request), notBound);
  const sent: unknown[] = [];
  const temporal = { workflow: { start: async (...args: unknown[]) => void sent.push(args) } };
  const known = new Map([["probe_echo", { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE }]]);
  const unbind = bindWorkflowStarter(workflowStarter(temporal as never, known, "test"));
  const unknown = { code: "worker_workflow_unknown", details: { workflow: "probe_other" } };
  await assert.rejects(startWorkflow({ ...request, workflow: "probe_other" }), unknown);
  const fields = { workflow: "probe_echo", fields: ["workspaceId"] };
  const invalid = { code: "workflow_input_invalid", details: fields };
  await assert.rejects(startWorkflow({ ...request, input: { workspace: "ws_1" } }), invalid);
  const started = await startWorkflow({ ...request, input: { workspaceId: "ws_1", note: "x" } });
  assert.deepEqual(started, { started: true });
  const options = { workflowId: "probe:1", taskQueue: "test", args: [{ workspaceId: "ws_1" }] };
  const policies = { workflowIdReusePolicy: "REJECT_DUPLICATE", workflowIdConflictPolicy: "FAIL" };
  assert.deepEqual(sent, [["probe_echo", { ...options, ...policies }]]);
  await startWorkflow({ ...request, oneAtATime: true });
  const oneAtATime = { ...policies, workflowIdReusePolicy: "ALLOW_DUPLICATE" };
  assert.deepEqual(sent[1], ["probe_echo", { ...options, ...oneAtATime }]);
  unbind();
  await assert.rejects(startWorkflow(request), notBound);
});

test("GET /health answers 503 when its report rejects", async () => {
  const health = await startHealth(0, () => Promise.reject(new Error("report failed")));
  try {
    const answer = await fetch(health.url);
    assert.equal(answer.status, 503);
    assert.deepEqual(await answer.json(), { status: "failing" });
  } finally {
    await health.close();
  }
});

test("onWorkerStart runs with the host's logger; one that is no function or throws is worker_module_invalid; credits' binds its client", async () => {
  const log = createLogger({ destination: collectLogs().destination });
  const probe = (onWorkerStart: unknown) => ({
    name: "probe",
    workflows: async () => ({ onWorkerStart }),
  });
  const seen: Logger[] = [];
  await startModules(
    await loadModules([probe(async ({ log }: { log: Logger }) => void seen.push(log))]),
    log,
  );
  assert.ok(seen.length === 1 && seen[0] === log);
  const invalid = {
    code: "worker_module_invalid",
    details: { module: "probe", field: "onWorkerStart" },
  };
  await assert.rejects(loadModules([probe("yes")]), invalid);
  const throwing = await loadModules([probe(() => Promise.reject(new Error("probe: refused")))]);
  await assert.rejects(startModules(throwing, log), invalid);

  await assert.rejects(credits.priceOf("test.read"), { code: "credits_not_bound" });
  const own = moduleLoaders.filter(({ name }) => name === "credits");
  await startModules(await loadModules(own), log);
  await assert.rejects(credits.priceOf("test.read"), { code: "no_tenant_context" });
});

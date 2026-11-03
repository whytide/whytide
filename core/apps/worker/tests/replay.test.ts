// The harness (testing/index.ts): the recorded history of fixture_echo replays against the fixture
// workflow and fails against an edit that adds a timer before its activity; runWorkflow runs the
// workflow on the slice's Temporal with an activity override. The bundles are of the fixture's build,
// as the worker's are of the modules' (README "Modules").
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { replayHistories, runWorkflow, withTestWorkflowEnvironment } from "../testing/index.ts";

const workflows = join(import.meta.dirname, "../dist/tests/fixtures/module/workflows");
const sources = join(import.meta.dirname, "fixtures", "module", "workflows");
const history = join(sources, "__histories__", "fixture_echo.json");
withTestWorkflowEnvironment({ workflowsPath: join(workflows, "workflows.js") });

test("a recorded history replays against the code that made it, not after a non-deterministic edit", async () => {
  await replayHistories(join(workflows, "workflows.js"), [history]);
  await assert.rejects(replayHistories(join(workflows, "workflows-edited.js"), [history]), {
    name: "DeterminismViolationError",
  });
});

test("runWorkflow runs a workflow on the slice's Temporal with an activity override", async () => {
  const fixture_tenant = async (input: { workspaceId: string }) => ({ ...input, overridden: true });
  const result = await runWorkflow(
    "fixture_echo",
    { workspaceId: "ws_1" },
    { activities: { fixture_tenant } },
  );
  assert.deepEqual(result, { workspaceId: "ws_1", overridden: true });
});

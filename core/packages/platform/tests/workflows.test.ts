// startWorkflow on demand (workflows/): workflows_not_bound until a host binds a starter, then the
// request reaches the starter as given, `oneAtATime` included, and an unbind puts the previous one
// back. cancelWorkflow the same with a canceller. The Temporal policies each request maps to are the
// worker's (core/apps/worker/tests).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppError } from "../errors/index.ts";
import {
  bindWorkflowCanceller,
  bindWorkflowStarter,
  cancelWorkflow,
  startWorkflow,
  type WorkflowCancel,
  type WorkflowStart,
} from "../workflows/index.ts";

test("a start is workflows_not_bound until bound, then reaches the starter with oneAtATime", async () => {
  const request: WorkflowStart = {
    workflow: "fixture_batch",
    input: { workspaceId: "wsp_1" },
    workflowId: "fixture.batch:wsp_1:current",
    oneAtATime: true,
  };
  await assert.rejects(startWorkflow(request), (error: unknown) => {
    assert.ok(isAppError(error));
    assert.equal(error.code, "workflows_not_bound");
    return true;
  });

  const seen: WorkflowStart[] = [];
  const unbind = bindWorkflowStarter({
    async start(next) {
      seen.push(next);
      return { started: seen.length === 1 };
    },
  });
  try {
    assert.deepEqual(await startWorkflow(request), { started: true });
    assert.deepEqual(await startWorkflow({ ...request, oneAtATime: undefined }), {
      started: false,
    });
    assert.equal(seen[0]?.oneAtATime, true);
    assert.equal(seen[1]?.oneAtATime, undefined);
  } finally {
    unbind();
  }
  await assert.rejects(startWorkflow(request), /workflows_not_bound/);
});

test("a cancel is workflows_not_bound until bound, as a start, then reaches the canceller by its id", async () => {
  const request: WorkflowCancel = { workflowId: "fixture-wsp_1-2026-10-28T00:00:00Z" };
  await assert.rejects(cancelWorkflow(request), (error: unknown) => {
    assert.ok(isAppError(error));
    assert.equal(error.code, "workflows_not_bound");
    assert.equal(error.status, 500);
    return true;
  });

  const seen: WorkflowCancel[] = [];
  const unbind = bindWorkflowCanceller({
    async cancel(next) {
      seen.push(next);
      return { cancelled: seen.length === 1 };
    },
  });
  try {
    assert.deepEqual(await cancelWorkflow(request), { cancelled: true });
    assert.deepEqual(await cancelWorkflow(request), { cancelled: false });
    assert.deepEqual(seen, [request, request]);
  } finally {
    unbind();
  }
  await assert.rejects(cancelWorkflow(request), /workflows_not_bound/);
});

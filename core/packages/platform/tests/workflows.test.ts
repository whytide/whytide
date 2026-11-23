// startWorkflow on demand (workflows/): workflows_not_bound until a host binds a starter, then the
// request reaches the starter as given, `oneAtATime` included, and an unbind puts the previous one
// back. cancelWorkflow the same with a canceller. The Temporal policies each request maps to are the
// worker's (core/apps/worker/tests). defineActivity refuses an activity's own `attempts` off 1 to its
// kind's bound and a `notRetried` entry that is no registered code; the worker obeys the rest
// (core/apps/worker/tests/activity-bounds.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineErrors, httpStatus, isAppError } from "../errors/index.ts";
import {
  ACTIVITY_ATTEMPTS,
  type ActivityDefinition,
  bindWorkflowCanceller,
  bindWorkflowStarter,
  cancelWorkflow,
  defineActivity,
  startWorkflow,
  type WorkflowCancel,
  type WorkflowStart,
  workflowInput,
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

test("defineActivity takes attempts from 1 to its kind's bound and notRetried of registered codes", () => {
  const { fixture_mail_refused } = defineErrors({ fixture_mail_refused: {} });
  const run = async () => undefined;
  for (const kind of ["provider", "ai", "db"] as const) {
    for (const attempts of [1, ACTIVITY_ATTEMPTS[kind]]) {
      assert.equal(
        defineActivity({ kind, input: workflowInput, attempts, run }).attempts,
        attempts,
      );
    }
  }
  const notRetried = [fixture_mail_refused, "workflows_not_bound"];
  const mail = defineActivity({ kind: "provider", input: workflowInput, notRetried, run });
  assert.deepEqual(mail.notRetried, notRetried);
  assert.equal(defineActivity({ kind: "db", input: workflowInput, run }).attempts, undefined);
});

test("defineActivity refuses attempts 0, above its kind's bound or not whole, and a notRetried entry that is no code: activity_definition_invalid, 500", () => {
  const { fixture_send_refused } = defineErrors({ fixture_send_refused: {} });
  const run = async () => undefined;
  const refused = (definition: ActivityDefinition, details: Record<string, unknown>) =>
    assert.throws(
      () => defineActivity(definition),
      (error: unknown) => {
        assert.ok(isAppError(error));
        assert.equal(error.code, "activity_definition_invalid");
        assert.equal(error.status, 500);
        assert.deepEqual(error.details, details);
        return true;
      },
    );
  const input = workflowInput;
  refused({ kind: "provider", input, attempts: 0, run }, { field: "attempts", kind: "provider" });
  refused({ kind: "provider", input, attempts: 6, run }, { field: "attempts", kind: "provider" });
  refused({ kind: "ai", input, attempts: 4, run }, { field: "attempts", kind: "ai" });
  refused({ kind: "db", input, attempts: 2.5, run }, { field: "attempts", kind: "db" });
  refused({ kind: "db", input, attempts: -1, run }, { field: "attempts", kind: "db" });
  const typo = ["fixture_send_refusd"];
  refused(
    { kind: "provider", input, notRetried: typo, run },
    {
      field: "notRetried",
      kind: "provider",
      index: 0,
    },
  );
  const sentence = [fixture_send_refused, "Send refused"];
  refused(
    { kind: "provider", input, notRetried: sentence, run },
    {
      field: "notRetried",
      kind: "provider",
      index: 1,
    },
  );
  assert.equal(httpStatus("activity_definition_invalid"), 500);
});

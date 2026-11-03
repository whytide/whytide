// The batch's units (README "The batch"): the reservation's idempotency key, and the two subscribers,
// which start the batch of the workspace they are delivered in, one at a time by its fixed id. The
// batch itself runs end to end in core/apps/worker/tests/qualification-batch.test.ts: a module never
// imports a host.
import assert from "node:assert/strict";
import test from "node:test";
import { events as discovery } from "@whytide/discovery";
import { events as icp } from "@whytide/icp";
import {
  bindWorkflowStarter,
  servicePrincipal,
  subscribersOf,
  type WorkflowStart,
  withTenantContext,
} from "@whytide/platform";
import { batchStart } from "../events.ts";
import { assessmentKey } from "../workflows/batch.ts";
import { workflows } from "../workflows/index.ts";

test("the idempotency key is qual:{personId}:{icpVersion}:{model}:{promptVersion}, then :{attempt} from the second", () => {
  const key = { personId: "per_1", icpVersion: 3, modelId: "fake-model", promptVersion: 1 };
  assert.equal(assessmentKey(key), "qual:per_1:3:fake-model:1");
  assert.equal(assessmentKey({ ...key, attempt: 1 }), "qual:per_1:3:fake-model:1");
  assert.equal(assessmentKey({ ...key, attempt: 2 }), "qual:per_1:3:fake-model:1:2");
  assert.notEqual(assessmentKey({ ...key, icpVersion: 4 }), assessmentKey(key));
});

test("discovery.people_imported and icp.updated start qualification_batch of the delivered workspace, one at a time by qualification.batch:<workspace>:current", async () => {
  const start = batchStart("wsp_a");
  assert.deepEqual(start, {
    workflow: "qualification_batch",
    input: { workspaceId: "wsp_a" },
    workflowId: "qualification.batch:wsp_a:current",
    oneAtATime: true,
  });
  assert.deepEqual(workflows.qualification_batch.input.parse(start.input), start.input);

  const starts: WorkflowStart[] = [];
  const unbind = bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: true };
    },
  });
  const workspaceId = "wsp_delivered";
  const payloads = [
    [
      discovery["discovery.people_imported"],
      { workspaceId: "wsp_other", jobId: "job_1", personIds: ["per_1"] },
    ],
    [icp["icp.updated"], { workspaceId: "wsp_other", version: 2 }],
  ] as const;
  try {
    await withTenantContext({ workspaceId, principal: servicePrincipal("test") }, async () => {
      for (const [name, payload] of payloads) {
        const context = {
          id: "obx_a",
          name,
          workspaceId,
          createdAt: new Date(),
          attempt: 1,
          tx: {},
        };
        for (const handler of subscribersOf(name)) await handler(payload, context);
      }
    });
  } finally {
    unbind();
  }
  assert.deepEqual(starts, [batchStart(workspaceId), batchStart(workspaceId)]);
});

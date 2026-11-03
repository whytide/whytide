// The start a Draft's event asks of the worker (alpha-p4-020; README "The website fetch"): the
// workflow onboarding registers, an input its registration parses, ids only, and an id from the run;
// the subscriber hands it to startWorkflow, here to a starter of the test's, for the workspace of
// the delivery's tenant run. The run itself is the worker's test,
// core/apps/worker/tests/onboarding-fetch.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import {
  bindWorkflowStarter,
  servicePrincipal,
  subscribersOf,
  type WorkflowStart,
  withTenantContext,
} from "@whytide/platform";
import { draftStart, events } from "../events.ts";
import { workflows } from "../workflows/index.ts";

const run = { workspaceId: "wsp_a", companyKnowledgeId: "ck_a", draftRunId: "drun_b" };

test("a Draft's event starts onboarding_draft_company_knowledge by onboarding.draft:<workspace>:<run>, its input the registration's", () => {
  const start = draftStart(run);
  assert.equal(start.workflowId, "onboarding.draft:wsp_a:drun_b");
  assert.ok(Object.hasOwn(workflows, start.workflow));
  const registered = workflows.onboarding_draft_company_knowledge.input;
  assert.deepEqual(registered.parse(start.input), run);
  assert.notEqual(draftStart({ ...run, draftRunId: "drun_c" }).workflowId, start.workflowId);
});

test("the subscriber of onboarding.draft_requested hands that start to startWorkflow, for the workspace it is delivered in, never the payload's", async () => {
  const starts: WorkflowStart[] = [];
  const unbind = bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: true };
    },
  });
  const name = events["onboarding.draft_requested"];
  const workspaceId = "wsp_delivered";
  const context = { id: "obx_a", name, workspaceId, createdAt: new Date(), attempt: 1, tx: {} };
  try {
    await withTenantContext({ workspaceId, principal: servicePrincipal("test") }, async () => {
      for (const handler of subscribersOf(name)) await handler(run, context);
    });
  } finally {
    unbind();
  }
  assert.deepEqual(starts, [draftStart({ ...run, workspaceId })]);
  assert.equal(starts[0]?.input.workspaceId, workspaceId);
});

// The fixture module's registrations, as a module's workflows/index.ts exports them: one workflow,
// one database activity that reads the tenant settings of its run, and one schedule; then a global
// workflow, its activity, which answers its context's keys and the tenant scope it runs in and logs
// a line on the host's logger (kept by onWorkerStart), and its schedule; then fixture_hold, open
// until cancelled, whose activity keeps its context's workflowId at the start and in the handler;
// fixture_binds, whose activity calls startWorkflow, cancelWorkflow and pauseSchedule, which the
// host binds before it polls; and its alert event, fixture.pinged.
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  cancelWorkflow,
  currentTenant,
  currentTenantScope,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  type Logger,
  pauseSchedule,
  startWorkflow,
  workflowInput,
} from "@whytide/platform";
import { z } from "zod";

let log: Logger | undefined;
/** fixture_hold's steps, as its activity saw them: the input's workspace, its context's workflowId. */
export const held: Readonly<Record<"workspaceId" | "step" | "workflowId", string>>[] = [];

export const workflows = defineWorkflows({
  fixture_echo: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
  fixture_global: { input: globalWorkflowInput, taskQueue: DEFAULT_TASK_QUEUE, scope: "global" },
  fixture_hold: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
  fixture_binds: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
});

export const activities = {
  fixture_tenant: defineActivity({
    kind: "db",
    input: workflowInput,
    run: (input, context: ActivityContext<TenantClient>) =>
      context.tenant(async (tx) => {
        // db's fixture function reads the settings withTenant set; the tenant client refuses SQL naming them.
        const [row] = await tx.$queryRaw<{ workspace_id: string }[]>`
          SELECT * FROM db_test_tenant_settings()`;
        const actor = currentTenant().principal.userId;
        return { workspaceId: input.workspaceId, setting: row?.workspace_id, actor };
      }),
  }),
  fixture_global_probe: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: async (_input, context) => {
      log?.info("fixture: a global activity ran");
      return { context: Object.keys(context), scope: currentTenantScope()?.kind ?? null };
    },
  }),
  fixture_hold_step: defineActivity({
    kind: "db",
    input: workflowInput.extend({ step: z.enum(["started", "cancelled"]) }),
    run: async ({ workspaceId, step }, { workflowId }: ActivityContext) => {
      held.push({ workspaceId, step, workflowId });
    },
  }),
  fixture_binds_probe: defineActivity({
    kind: "db",
    input: workflowInput,
    run: async ({ workspaceId }) => {
      const workflowId = `fixture.binds:${workspaceId}`;
      const input = { workspaceId };
      const { started } = await startWorkflow({ workflow: "fixture_echo", input, workflowId });
      await cancelWorkflow({ workflowId });
      const { found } = await pauseSchedule(`fixture-binds-${workspaceId}`, true);
      return { started, found };
    },
  }),
};

export const schedules = defineSchedules([
  {
    id: "tick",
    workflow: "fixture_echo",
    spec: { intervals: [{ every: "365 days" }] },
    input: { workspaceId: "ws_fixture" },
  },
  {
    id: "global_tick",
    workflow: "fixture_global",
    spec: { intervals: [{ every: "365 days" }] },
    input: {},
  },
]);

export const alerts = ["fixture.pinged"];

export async function onWorkerStart(context: { readonly log: Logger }): Promise<void> {
  log = context.log;
}

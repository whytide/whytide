// What the worker host loads of privacy (core/apps/worker/docs/workflows.md; README.md "The 30-day
// rule"): the daily workflow privacy_retention, global, its three activities, global too, so that
// each erasure opens its own tenant run and none runs inside another, and its schedule; and
// onWorkerStart, which keeps the host's logger for the activities' lines. Inputs carry ids, the
// cutoff and counts only.
import {
  createLogger,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  type Logger,
} from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { z } from "zod";
import { RETENTION_AT_UTC, RETENTION_MAX_PER_RUN } from "../domain/retention/constants.ts";
import { runRetention, sweepRetention } from "../domain/retention/job.ts";

let log: Logger | undefined;
const logger = () => (log ??= createLogger());

const id = z.string().min(1).max(64);
const count = z.int().min(0);
/**
 * A workspace's run: the workspace, `workspace` since a global activity's input names no
 * `workspaceId` (core/apps/worker/src/modules.ts), and the workflow's cutoff.
 */
const runInput = globalWorkflowInput.extend({ workspace: id, cutoff: z.iso.datetime() });
/** The sweep's: the ids each workspace's run deleted, and the totals its line logs. */
const sweepInput = globalWorkflowInput.extend({
  deleted: z.array(z.object({ workspace: id, personIds: z.array(id).max(RETENTION_MAX_PER_RUN) })),
  totals: z.object({
    workspaces: count,
    candidates: count,
    deleted: count,
    skipped: count,
    failed: count,
    workspacesFailed: count,
  }),
});

export const workflows = defineWorkflows({
  privacy_retention: { input: globalWorkflowInput, taskQueue: DEFAULT_TASK_QUEUE, scope: "global" },
});

export const activities = {
  /** Every workspace's id, from tenancy, and nothing else: the job's fan-out. */
  privacy_retention_workspaces: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: async () => ({ workspaceIds: await listWorkspaceIds() }),
  }),
  /** The workspace's candidates at the cutoff deleted, each in a tenant run of its own. */
  privacy_retention_run: defineActivity({
    kind: "db",
    scope: "global",
    input: runInput,
    run: ({ workspace, cutoff }) => runRetention(workspace, new Date(cutoff), logger()),
  }),
  /** Every registered eraser again for the deleted persons; then the totals' line. */
  privacy_retention_sweep: defineActivity({
    kind: "db",
    scope: "global",
    input: sweepInput,
    run: (input) => sweepRetention(input, logger()),
  }),
};

/** Daily at RETENTION_AT_UTC (`HH:MM`); Temporal's default overlap policy skips a run while one runs. */
const [hour, minute] = RETENTION_AT_UTC.split(":").map(Number);
export const schedules = defineSchedules([
  {
    id: "retention",
    workflow: "privacy_retention",
    spec: { cronExpressions: [`${minute} ${hour} * * *`], timezone: "UTC" },
    input: {},
  },
]);

export async function onWorkerStart(context: { readonly log: Logger }): Promise<void> {
  log = context.log;
}

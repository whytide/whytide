// What the worker host loads of discovery (core/apps/worker/docs/workflows.md): the import's run,
// which discovery.import_run_requested starts (events.ts), with its two activities, the rows and the
// failure past their attempts. Inputs carry ids and a code only. Their database steps are the
// module's own runs (domain/store.ts), as the worker's service: a chunk's run may take a minute, past
// the five seconds of the host's context.tenant.
import {
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  servicePrincipal,
  workflowInput,
} from "@whytide/platform";
import { z } from "zod";
import { failImportRun, importRows } from "../domain/import/run.ts";

/** A job's run: the job the route claimed. */
export const importRunInput = workflowInput.extend({ jobId: z.string().min(1) });
const failedInput = importRunInput.extend({ code: z.string().min(1) });
const tenantOf = (workspaceId: string) => ({ workspaceId, principal: servicePrincipal("worker") });

export const workflows = defineWorkflows({
  discovery_import_run: { input: importRunInput, taskQueue: DEFAULT_TASK_QUEUE },
});

export const activities = {
  /** The job's valid rows, a person and a lead each, in chunks of 500, then the job done. */
  discovery_import_rows: defineActivity({
    kind: "db",
    input: importRunInput,
    run: ({ workspaceId, jobId }) => importRows(tenantOf(workspaceId), jobId),
  }),
  /** Once the rows failed past their attempts: the job ends failed with the code. */
  discovery_import_failed: defineActivity({
    kind: "db",
    input: failedInput,
    run: ({ workspaceId, jobId, code }) => failImportRun(tenantOf(workspaceId), jobId, code),
  }),
};

export const schedules = defineSchedules([]);

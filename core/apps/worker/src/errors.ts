// The worker's own codes (README "Errors"), developer-facing: no message keys.
import { defineErrors } from "@whytide/platform";

export const workerErrors = defineErrors({
  /** At start, a module export the worker cannot register: `details.module` and `details.field`. */
  worker_module_invalid: {},
  /** At start, a module's build missing: `details.missing` names the file; `pnpm -F worker build`. */
  worker_module_not_built: {},
  /** At start, a workflow, activity or schedule registered twice: `details.sources`. */
  worker_duplicate_registration: {},
  /** An activity's input off its schema; `details.fields` lists the paths. Not retried. */
  activity_input_invalid: {},
  /** An attempt past its activity's own bound, after a timeout the server retried. Not retried. */
  activity_attempts_exhausted: {},
  /** A thrown value that is not an AppError: the log line has its type and frames. */
  activity_failed: {},
  /** A workspace activity that no workflow scheduled, so with no workflowId for its context. */
  activity_not_in_workflow: {},
  /** startWorkflow naming a workflow no module registers: `details.workflow`. */
  worker_workflow_unknown: {},
  /** startWorkflow's input off its workflow's schema: `details.workflow` and `details.fields`. */
  workflow_input_invalid: {},
  /** smoke and history:record reach the Temporal of the stack on this machine only. */
  temporal_address_not_local: {},
});

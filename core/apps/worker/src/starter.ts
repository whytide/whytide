// The worker's starter of startWorkflow (README "Workflows"), bound at start: a subscriber starts a
// workflow by its name and a deterministic id. The input is parsed against the workflow's
// registration and what it declares is sent. An id that is running or has run starts nothing:
// Temporal's REJECT_DUPLICATE, within the namespace's retention, answered `{ started: false }`.
// With `oneAtATime`, ALLOW_DUPLICATE: only a running one does, and a closed one starts again.
import { type Client, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { AppError, type WorkflowRegistration, type WorkflowStarter } from "@whytide/platform";
import { workerErrors } from "./errors.ts";

/** The input as the workflow's registration reads it: an unknown workflow or an input off it throws. */
export function parseWorkflowInput(
  workflows: ReadonlyMap<string, WorkflowRegistration>,
  workflow: string,
  input: unknown,
): unknown {
  const registration = workflows.get(workflow);
  if (!registration) {
    throw new AppError(workerErrors.worker_workflow_unknown, { details: { workflow } });
  }
  const parsed = registration.input.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join("."));
    throw new AppError(workerErrors.workflow_input_invalid, { details: { workflow, fields } });
  }
  return parsed.data;
}

/** On the host's task queue, as the schedules: the loader admits DEFAULT_TASK_QUEUE alone. */
export function workflowStarter(
  temporal: Pick<Client, "workflow">,
  workflows: ReadonlyMap<string, WorkflowRegistration>,
  taskQueue: string,
): WorkflowStarter {
  return {
    async start({ workflow, input, workflowId, oneAtATime }) {
      const parsed = parseWorkflowInput(workflows, workflow, input);
      try {
        await temporal.workflow.start(workflow, {
          workflowId,
          taskQueue,
          args: [parsed],
          workflowIdReusePolicy: oneAtATime ? "ALLOW_DUPLICATE" : "REJECT_DUPLICATE",
          workflowIdConflictPolicy: "FAIL",
        });
        return { started: true };
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) return { started: false };
        throw error;
      }
    },
  };
}

// The activity wrapper (README "Activities"; docs/workflows.md): every module activity runs through
// it. It parses the input, gives `context.tenant`, one tenant run for the input's workspace as
// service:worker per database step, sets the log context, heartbeats every 20 seconds, and turns a
// failure into a Temporal failure carrying the code only, never a message, which could hold data,
// retried or not by retry.ts, after the provider's own delay when it gave one, and counted
// (worker.activity.failures). A cancellation passes through. `context.workflowId` is the id of the
// workflow that scheduled the activity: one no workflow scheduled fails activity_not_in_workflow.
// A global activity (`scope: "global"`) gets the attempt only: no workspace, no tenant run, and a
// log context of the actor alone.
import { ApplicationFailure, CancelledFailure, Context } from "@temporalio/activity";
import { type PrismaClient, type TenantClient, withTenant } from "@whytide/db";
import {
  type ActivityContext,
  type ActivityDefinition,
  AppError,
  isAppError,
  type LogContext,
  type Logger,
  servicePrincipal,
  withLogContext,
} from "@whytide/platform";
import { workerErrors } from "./errors.ts";
import { workerMetrics } from "./metrics.ts";
import { ACTIVITY_ATTEMPTS, retries, retryDelayMs } from "./retry.ts";

const HEARTBEAT_MS = 20_000;
const principal = servicePrincipal("worker");

export type ActivityHost = { readonly client?: PrismaClient; readonly log: Logger };

export function hostActivity(name: string, definition: ActivityDefinition, host: ActivityHost) {
  const { kind } = definition;
  return async (raw: unknown): Promise<unknown> => {
    const current = Context.current();
    const { attempt } = current.info;
    const failure = (error: unknown) => {
      const code = isAppError(error) ? error.code : workerErrors.activity_failed;
      host.log.warn({ err: error, activity: name, kind, attempt }, "worker: an activity failed");
      workerMetrics["worker.activity.failures"].add(1, { activity: name, code });
      const nonRetryable = !retries(kind, code, attempt);
      const nextRetryDelay = retryDelayMs(error);
      return ApplicationFailure.create({ message: code, type: code, nonRetryable, nextRetryDelay });
    };
    if (attempt > ACTIVITY_ATTEMPTS[kind]) {
      throw failure(new AppError(workerErrors.activity_attempts_exhausted));
    }
    const parsed = definition.input.safeParse(raw);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join("."));
      throw failure(new AppError(workerErrors.activity_input_invalid, { details: { fields } }));
    }
    const runIn = (log: LogContext, work: () => Promise<unknown>) =>
      withLogContext(log, async () => {
        const beat = setInterval(() => current.heartbeat(), HEARTBEAT_MS);
        try {
          return await work();
        } catch (error) {
          if (error instanceof CancelledFailure) throw error;
          throw failure(error);
        } finally {
          clearInterval(beat);
        }
      });
    const actor = principal.userId;
    if (definition.scope === "global") {
      return runIn({ actor }, () => definition.run(parsed.data, { attempt }));
    }
    const { workspaceId } = parsed.data as { workspaceId: string };
    // Unset only for a standalone activity, started by a client: no module starts one.
    const workflowId = current.info.workflowExecution?.workflowId;
    if (workflowId === undefined)
      throw failure(new AppError(workerErrors.activity_not_in_workflow));
    const context: ActivityContext<TenantClient> = {
      workspaceId,
      workflowId,
      attempt,
      tenant: (fn) => withTenant({ workspaceId, principal }, fn, { client: host.client }),
    };
    return runIn({ workspace_id: workspaceId, actor }, () => definition.run(parsed.data, context));
  };
}

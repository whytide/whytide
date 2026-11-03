// The events this module publishes, written to the outbox in the transaction of the change
// (docs/rules/coding.md §2, §3): ids only. Its own subscribers, in the worker, keep a source's
// schedule `signals-<sourceId>` (platform README "Workflows"), start a run asked for by hand and
// cancel a stopped run's workflow (README.md "Runs") and qualification's batch for the persons a run
// found ("Processing"), in the workspace of the delivery's tenant run, never the payload's.
import { tenantClient } from "@whytide/db";
import {
  cancelWorkflow,
  createLogger,
  createSchedule,
  currentTenant,
  defineEvents,
  deleteSchedule,
  pauseSchedule,
  startWorkflow,
  subscribe,
} from "@whytide/platform";
import { batchStart } from "@whytide/qualification";
import { z } from "zod";
import { runNowWorkflowIdOf } from "./domain/constants.ts";
import { registeredSourceKinds } from "./sources/registry.ts";

const source = z.strictObject({ source_id: z.string() });
const run = z.strictObject({ source_id: z.string(), run_id: z.string() });

export const events = defineEvents({
  "signals.source_created": source,
  /** Its `enabled` changed. */
  "signals.source_updated": source,
  /** With its open runs' workflows, read before the delete took the rows, none when it had none. */
  "signals.source_deleted": z.strictObject({
    source_id: z.string(),
    workflow_ids: z.array(z.string()).optional(),
  }),
  /** A run ended `failed` on its sender account, not connected: the source cannot run until it is. */
  "signals.source_blocked": run,
  /** A run by hand, its row written: the worker starts it. */
  "signals.run_requested": run,
  /** A stop asked, its `stop_requested_at` set: the worker cancels the run's workflow. */
  "signals.run_stop_requested": run,
  /** A processing step's new leads, ids only, a chunk at a time (alpha-p8-030). */
  "signals.person_found": z.strictObject({
    workspaceId: z.string(),
    personIds: z.array(z.string()).min(1).max(100),
  }),
});

/** A source's schedule in Temporal. */
export const scheduleIdOf = (sourceId: string): string => `signals-${sourceId}`;
/** The workflow of a run, scheduled or by hand (workflows/workflows.ts). */
const RUN_WORKFLOW = "signals_run";
let log: ReturnType<typeof createLogger> | undefined;

/** A source's row, as far as its schedule needs it. */
type Schedulable = {
  readonly id: string;
  readonly kind: string;
  readonly config: unknown;
  readonly createdAt: Date;
  readonly enabled: boolean;
  readonly lastRunAt: Date | null;
};

/**
 * The source's schedule: its kind's fire times from the save, and one run now when one has passed
 * since its last run (the run at save, for a new source). A kind no longer registered gets none; a
 * schedule that exists already stays as it is.
 */
async function scheduleSource(found: Schedulable): Promise<void> {
  const kind = registeredSourceKinds().get(found.kind);
  if (!kind) return;
  const at = kind.schedule(found.config, found.createdAt);
  const after = found.lastRunAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  await createSchedule({
    scheduleId: scheduleIdOf(found.id),
    workflow: RUN_WORKFLOW,
    input: { workspaceId: currentTenant().workspaceId, sourceId: found.id },
    at,
    startNow: at.some((time) => time.getTime() <= Date.now() && time.getTime() > after),
    paused: !found.enabled,
  });
}

// A source gone since gets none; a second delivery creates nothing.
subscribe(events["signals.source_created"], async ({ source_id }) => {
  const found = await tenantClient.signalSource.findFirst({ where: { id: source_id } });
  if (found) await scheduleSource(found);
});

// Paused while the source is disabled, as it is when the event is delivered. A source with no
// schedule (saved before alpha-p8-020, or its created event failed) gets one when it is enabled.
subscribe(events["signals.source_updated"], async ({ source_id }) => {
  const found = await tenantClient.signalSource.findFirst({ where: { id: source_id } });
  if (!found) return;
  const paused = await pauseSchedule(scheduleIdOf(found.id), !found.enabled);
  if (!paused.found && found.enabled) await scheduleSource(found);
});

/**
 * A run's workflow cancelled: it ends `cancelled` through its own last step. `{ cancelled: false }`
 * is no failure: the run had ended. One line, ids only.
 */
async function cancelRun(workflowId: string, ids: { source_id: string; run_id?: string }) {
  const { cancelled } = await cancelWorkflow({ workflowId });
  const line = { ...ids, workflow_id: workflowId, outcome: cancelled ? "cancelled" : "not_open" };
  (log ??= createLogger()).info(line, "signals: a run's workflow cancelled");
}

// The open runs of a source deleted stop too: their rows went with it, so the event names them.
subscribe(events["signals.source_deleted"], async ({ source_id, workflow_ids = [] }) => {
  await deleteSchedule(scheduleIdOf(source_id));
  for (const workflowId of workflow_ids) await cancelRun(workflowId, { source_id });
});

// By an id from the run's: a second delivery starts no second run.
subscribe(events["signals.run_requested"], async ({ source_id, run_id }) => {
  const { workspaceId } = currentTenant();
  await startWorkflow({
    workflow: RUN_WORKFLOW,
    input: { workspaceId, sourceId: source_id, runId: run_id },
    workflowId: runNowWorkflowIdOf(workspaceId, run_id),
  });
});

// A running or waiting run only, by the id its start recorded, else a run by hand's (a run started
// before fix-run-stop). One not started yet is its start's to end (domain/runs.ts startRun): a cancel
// could reach its workflow before that first step, which would leave the row `scheduled`. One that
// ended meanwhile, or went with its source, needs none.
subscribe(events["signals.run_stop_requested"], async ({ source_id, run_id }) => {
  const found = await tenantClient.signalRun.findFirst({ where: { id: run_id } });
  if (found?.status !== "running" && found?.status !== "waiting") return;
  const workflowId = found.workflowId ?? runNowWorkflowIdOf(currentTenant().workspaceId, run_id);
  await cancelRun(workflowId, { source_id, run_id });
});

// The persons a run found go to qualification's batch, which signals starts as qualification's own
// subscribers do (decisions.md, 2026-10-22: qualification never imports signals). One run at a time.
subscribe(events["signals.person_found"], async () => {
  await startWorkflow(batchStart(currentTenant().workspaceId));
});

// What the worker host loads of qualification (core/apps/worker/docs/workflows.md; README "The
// batch"): the workspace's batch and its five activities; the tick, global, which starts one batch per
// workspace, and its schedule; the re-score and its page (README "The re-score"). Inputs carry ids,
// the ICP version and codes only.
import {
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  workflowInput,
} from "@whytide/platform";
import { z } from "zod";
import { RESCORE_PAGE, rescorePage } from "../domain/rescore.ts";
import { settings } from "../settings.ts";
import {
  assessLead,
  commitLead,
  filterLeads,
  releaseLead,
  reserveLead,
  startBatches,
} from "./batch.ts";

const id = z.string().min(1).max(64);
/** A lead's status_reason: a code, never a message. */
const code = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** One lead of the batch: the person and the ICP version the batch read. */
const leadInput = workflowInput.extend({ personId: id, icpVersion: z.int().min(1) });
/** The lead with its reservation and the attempt it is for; an older history names none. */
const heldInput = leadInput.extend({ usageId: id, attempt: z.int().min(1).optional() });

export const workflows = defineWorkflows({
  qualification_batch: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
  qualification_batch_tick: {
    input: globalWorkflowInput,
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
  qualification_rescore: {
    input: workflowInput.extend({ personIds: z.array(id).min(1).max(500).optional() }),
    taskQueue: DEFAULT_TASK_QUEUE,
  },
});

export const activities = {
  /** Lists the workspaces and starts the batch of each with work, unless one runs. */
  qualification_start_batches: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: startBatches,
  }),
  /** Selects the leads and writes those the hard filters stop. */
  qualification_filter_leads: defineActivity({
    kind: "db",
    input: workflowInput,
    run: filterLeads,
  }),
  /** Reserves one assessment under the lead's attempt, or marks the lead insufficient_credits. */
  qualification_reserve: defineActivity({ kind: "db", input: leadInput, run: reserveLead }),
  /** The model's assessment, stored as a snapshot. */
  qualification_assess: defineActivity({ kind: "ai", input: leadInput, run: assessLead }),
  /** Scores the snapshot, writes the lead and commits the reservation, or answers its lease ran out. */
  qualification_commit: defineActivity({
    kind: "db",
    input: heldInput.extend({ snapshotId: id }),
    run: commitLead,
  }),
  /** Releases the reservation, moves the attempt and, given a reason, writes the lead's failure. */
  qualification_release: defineActivity({
    kind: "db",
    input: heldInput.extend({ reason: code.optional() }),
    run: releaseLead,
  }),
  /** Re-scores one page of leads from their stored verdicts, in one run. */
  qualification_rescore_page: defineActivity({
    kind: "db",
    input: workflowInput.extend({
      personIds: z.array(id).min(1).max(RESCORE_PAGE).optional(),
      after: id.optional(),
    }),
    run: (input, context) => context.tenant(() => rescorePage(input)),
  }),
};

/** Every QUALIFICATION_SCHEDULE_MINUTES; Temporal's default overlap policy skips a tick while one runs. */
const every = settings.QUALIFICATION_SCHEDULE_MINUTES * 60_000;
export const schedules = defineSchedules([
  {
    id: "batch_tick",
    workflow: "qualification_batch_tick",
    spec: { intervals: [{ every }] },
    input: {},
  },
]);

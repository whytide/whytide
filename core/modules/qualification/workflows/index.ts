// What the worker host loads of qualification (core/apps/worker/docs/workflows.md; README "The
// batch"): the workspace's batch and its five activities; the tick, global, which starts one batch per
// workspace, and its schedule; the re-score and its page (README "The re-score"); the nightly decay's
// tick, global, its schedule and each workspace's decay by pages (README "Intent and priority"); one
// entry's Hot alert and its mail, kind `provider` with one attempt (README "The Hot alert"). And
// onWorkerStart, which keeps the host's logger for the alert's line. Inputs carry ids, the audience
// and its version, codes and the decay's time only.
import type { TenantClient } from "@whytide/db";
import {
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  type Logger,
  workflowInput,
} from "@whytide/platform";
import { z } from "zod";
import { type HotAlertResult, mailHotLead, useAlertLog } from "../domain/alert/mail.ts";
import { INTENT_DECAY_AT_UTC } from "../domain/intent/constants.ts";
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
import { decayPage, startIntentDecays } from "./intent-decay.ts";

const id = z.string().min(1).max(64);
/** A lead's status_reason: a code, never a message. */
const code = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/**
 * One lead of the batch: the person, its audience and the version the batch read; an older history
 * names no audience, the default's (gamma-p5-050).
 */
const leadInput = workflowInput.extend({
  personId: id,
  icpId: id.optional(),
  icpVersion: z.int().min(1),
});
/** The lead with its reservation and the attempt it is for; an older history names none. */
const heldInput = leadInput.extend({ usageId: id, attempt: z.int().min(1).optional() });
/** The decay's time: the tick's, which a test may give. */
const at = z.iso.datetime();
/** One entry into Hot: the person whose alert the subscriber claimed. */
const alertInput = workflowInput.extend({ personId: id });

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
  qualification_intent_decay_tick: {
    input: globalWorkflowInput.extend({ at: at.optional() }),
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
  qualification_intent_decay: {
    input: workflowInput.extend({ at }),
    taskQueue: DEFAULT_TASK_QUEUE,
  },
  qualification_hot_alert: { input: alertInput, taskQueue: DEFAULT_TASK_QUEUE },
});

export const activities = {
  /** Lists the workspaces and starts the batch of each with work, unless one runs. */
  qualification_start_batches: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: startBatches,
  }),
  /** Selects the leads, each with its audience, and writes those the hard filters stop. */
  qualification_filter_leads: defineActivity({
    kind: "db",
    input: workflowInput.extend({ audiences: z.literal(true).optional() }),
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
  /** Starts every workspace's decay as of the tick's time, unless one runs. */
  qualification_start_intent_decays: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput.extend({ at }),
    run: startIntentDecays,
  }),
  /** Recomputes one page of the workspace's decaying intents, each person in a run of its own. */
  qualification_intent_decay_page: defineActivity({
    kind: "db",
    input: workflowInput.extend({ at }),
    run: decayPage,
  }),
  /** The Hot alert's mail through the app-mail port: one attempt, a failed send is not retried. */
  qualification_mail_hot_lead: defineActivity<typeof alertInput, HotAlertResult, TenantClient>({
    kind: "provider",
    attempts: 1,
    input: alertInput,
    run: (input, context) => mailHotLead(context, input.personId),
  }),
};

/** Every QUALIFICATION_SCHEDULE_MINUTES; Temporal's default overlap policy skips a tick while one runs. */
const every = settings.QUALIFICATION_SCHEDULE_MINUTES * 60_000;
/** Daily at INTENT_DECAY_AT_UTC (`HH:MM`), as a cron expression. */
const [hour, minute] = INTENT_DECAY_AT_UTC.split(":").map(Number);
export const schedules = defineSchedules([
  {
    id: "batch_tick",
    workflow: "qualification_batch_tick",
    spec: { intervals: [{ every }] },
    input: {},
  },
  {
    id: "intent_decay",
    workflow: "qualification_intent_decay_tick",
    spec: { cronExpressions: [`${minute} ${hour} * * *`], timezone: "UTC" },
    input: {},
  },
]);

/** Before the worker polls: the host's logger, for the Hot alert's line. */
export async function onWorkerStart(context: { readonly log: Logger }): Promise<void> {
  useAlertLog(context.log);
}

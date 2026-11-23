// What the worker host loads of messaging (core/apps/worker/docs/workflows.md; README.md "The
// workflow"): the draft's workflow, its writer and its failure mark; the sweep, global and hourly,
// workspace by workspace, as linkedin_status_refresh loops, a page of workspaces a run (pages.ts).
// Inputs carry ids, and a continued sweep's counts, only.
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  workflowInput,
} from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { z } from "zod";
import { EARLIER_DRAFTS_MAX } from "../domain/drafts/constants.ts";
import { markFailed } from "../domain/drafts/store.ts";
import { sweepStuckDrafts } from "../domain/drafts/sweep.ts";
import { type DraftContext, writeDraft } from "../domain/drafts/write.ts";
import { SWEEP } from "./constants.ts";
import { workspacePage } from "./pages.ts";

const id = z.string().min(1).max(64);
/**
 * A draft's run (messaging.draft_requested): the draft, its lead, its member, what it replaces;
 * for a sequence step's draft, the earlier drafts it builds on, by id.
 */
export const draftInput = workflowInput.extend({
  draftId: id,
  personId: id,
  userId: id,
  replacesId: id.optional(),
  earlierDraftIds: z.array(id).max(EARLIER_DRAFTS_MAX).optional(),
});

/** A page of the sweep's workspaces: the ones after its cursor (gamma-p0-085). */
const pageInput = globalWorkflowInput.extend({ afterId: id.optional() });
const count = z.int().min(0);
/** The sweep's: continued as new, its cursor and its counts so far (gamma-p0-085). */
const sweepInput = pageInput.extend({
  counts: z.strictObject({ stuck: count, unswept: count }).optional(),
});

export const workflows = defineWorkflows({
  messaging_draft_message: { input: draftInput, taskQueue: DEFAULT_TASK_QUEUE },
  messaging_sweep: { input: sweepInput, taskQueue: DEFAULT_TASK_QUEUE, scope: "global" },
});

export const activities = {
  /** Plans, writes and checks the draft, and stores it (README.md "The writer"). */
  messaging_write_draft: defineActivity({
    kind: "ai",
    input: draftInput,
    run: (draft, context: DraftContext) => writeDraft(draft, context),
  }),
  /** Once the writer failed past its attempts: the draft ends `failed`, write_failed. */
  messaging_draft_failed: defineActivity({
    kind: "db",
    input: draftInput,
    run: (draft, context: ActivityContext<TenantClient>) =>
      context.tenant(() => markFailed(draft.draftId)),
  }),
  /**
   * A page of the workspaces' ids, from tenancy, and nothing else: the sweep's fan-out, after the
   * run's cursor, with the next page's cursor, or null after the last (pages.ts).
   */
  messaging_list_workspaces: defineActivity({
    kind: "db",
    scope: "global",
    input: pageInput,
    run: async ({ afterId }) => workspacePage(await listWorkspaceIds(), afterId),
  }),
  /** The workspace's drafts stuck in `drafting`, failed, draft_stuck: how many. */
  messaging_sweep_workspace: defineActivity({
    kind: "db",
    input: workflowInput,
    run: (_input, context: ActivityContext<TenantClient>) =>
      context.tenant(() => sweepStuckDrafts()),
  }),
};

/** Hourly: the sweep of the drafts no run will write (docs/runbook.md). */
export const schedules = defineSchedules([
  {
    id: "sweep",
    workflow: "messaging_sweep",
    spec: { intervals: [{ every: SWEEP.every }] },
    input: {},
  },
]);

// What the worker host loads of icp (core/apps/worker/docs/workflows.md): the draft's workflow, its
// drafter and the failure mark once the drafter's attempts are spent. Inputs carry ids only.
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  workflowInput,
} from "@whytide/platform";
import { z } from "zod";
import { recordDraft } from "../domain/draft.ts";
import { type DraftContext, draftProfile } from "../domain/drafter.ts";
import { DRAFT_RUN_CODES } from "../domain/lists.ts";

/** A draft's run: the ICP and the run the request started (icp.draft_requested). */
export const draftInput = workflowInput.extend({
  icpId: z.string().min(1),
  draftRunId: z.string().min(1),
});

export const workflows = defineWorkflows({
  icp_draft_profile: { input: draftInput, taskQueue: DEFAULT_TASK_QUEUE },
});

export const activities = {
  /** Drafts the ICP from the Company Knowledge and the brief (README "The draft"). */
  icp_draft_from_sources: defineActivity({
    kind: "ai",
    input: draftInput,
    run: (run, context: DraftContext) => draftProfile(run, context),
  }),
  /** Once the drafter failed past its attempts: the run ends `failed`, draft_failed. */
  icp_draft_failed: defineActivity({
    kind: "db",
    input: draftInput,
    run: (run, context: ActivityContext<TenantClient>) =>
      context.tenant(() => recordDraft(run, { ok: false, code: DRAFT_RUN_CODES.draftFailed })),
  }),
};

export const schedules = defineSchedules([]);

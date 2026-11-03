// What the worker host loads of messaging (core/apps/worker/docs/workflows.md; README.md "The
// workflow"): the draft's workflow, its writer and its failure mark. Inputs carry ids only.
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
import { markFailed } from "../domain/drafts/store.ts";
import { type DraftContext, writeDraft } from "../domain/drafts/write.ts";

const id = z.string().min(1).max(64);
/** A draft's run (messaging.draft_requested): the draft, its lead, its member, what it replaces. */
export const draftInput = workflowInput.extend({
  draftId: id,
  personId: id,
  userId: id,
  replacesId: id.optional(),
});

export const workflows = defineWorkflows({
  messaging_draft_message: { input: draftInput, taskQueue: DEFAULT_TASK_QUEUE },
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
};

export const schedules = defineSchedules([]);

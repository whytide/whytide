// The drafter (README "The draft"), the body of icp_draft_from_sources: a tenant run reads the sources;
// callAgent asks the model outside any run (it opens its own for the cache, the decision record and
// the cost event); a second run writes the pending draft or the failure under the row lock. Nothing
// here logs: the sources, the prompt and the draft stay out of every log line.
import { agentModel, type CallOptions, callAgent, registeredAgentTasks } from "@whytide/ai";
import type { TenantClient } from "@whytide/db";
import { type ActivityContext, AppError } from "@whytide/platform";
import type { draftProfileTask } from "../agents/draft-profile/task.ts";
import { draftErrors } from "../errors.ts";
import { DRAFT_PROFILE } from "../schemas/draft-profile.ts";
import {
  type DraftOutcome,
  type DraftResult,
  type DraftRun,
  draftSources,
  recordDraft,
} from "./draft.ts";
import { DRAFT_RUN_CODES } from "./lists.ts";

/** Where the drafter runs: the activity's tenant runs; callAgent's options in a test. */
export type DraftContext = Pick<ActivityContext<TenantClient>, "tenant"> & {
  readonly call?: CallOptions;
};

/**
 * Drafts the ICP of `run`: `drafted` with the pending draft, or `failed` with ai_failed when the
 * answer failed its schema or its gate twice, or icp_draft_no_source when the sources were emptied
 * since the request; `superseded`, with no model asked and nothing written, once a later request
 * started. Unchanged sources are the cached answer.
 */
export async function draftProfile(run: DraftRun, context: DraftContext): Promise<DraftResult> {
  const task = registeredTask();
  const sources = await context.tenant(() => draftSources(run));
  if (sources === null) return { status: "superseded" };
  let outcome: DraftOutcome = { ok: false, code: draftErrors.icp_draft_no_source };
  if (sources.input !== null) {
    const call = { workspaceId: run.workspaceId, subjectRef: run.icpId, input: sources.input };
    const result = await callAgent(task, call, context.call);
    outcome = { ok: false, code: DRAFT_RUN_CODES.aiFailed };
    if (result.status === "ok") {
      const { modelId } = await agentModel(task);
      const { decisionRecordId, output } = result;
      const draft = { model: modelId, promptVersion: task.promptVersion, decisionRecordId };
      outcome = { ok: true, draft: { ...draft, fields: output } };
    }
  }
  return context.tenant(() => recordDraft(run, outcome));
}

/** The task the host registered at start (loadAgentTasks); never imported here (agents/). */
function registeredTask(): typeof draftProfileTask {
  const task = registeredAgentTasks().get(DRAFT_PROFILE);
  if (task === undefined) throw new AppError(draftErrors.icp_draft_agent_not_loaded);
  return task as unknown as typeof draftProfileTask;
}

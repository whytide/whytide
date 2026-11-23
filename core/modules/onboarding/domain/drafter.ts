// The drafter's step of a Draft (README "The drafter"), the body of onboarding_draft_from_pages: a
// tenant run reads the pages and the documents; callAgent asks the model outside any run (it opens
// its own for the cache, the decision record and the cost event); a second run writes the draft or
// ai_failed under the row lock. Nothing here logs: the pages, the documents, the prompt and the draft
// stay out of every log line.
import { agentModel, type CallOptions, callAgent, registeredAgentTasks } from "@whytide/ai";
import type { TenantClient } from "@whytide/db";
import { type ActivityContext, AppError } from "@whytide/platform";
import type { draftCompanyKnowledgeTask } from "../agents/draft-company-knowledge/task.ts";
import { errors } from "../errors.ts";
import { DRAFT_COMPANY_KNOWLEDGE, type DraftInput } from "../schemas/draft-company-knowledge.ts";
import {
  type DraftOutcome,
  type DraftRun,
  draftDocuments,
  draftPages,
  type RunResult,
  recordDraft,
} from "./draft.ts";

/** Where the drafter runs: the activity's tenant runs; callAgent's options in a test. */
export type DraftContext = Pick<ActivityContext<TenantClient>, "tenant"> & {
  readonly call?: CallOptions;
};

/**
 * Drafts the record of `run` from the pages its fetch read, then the documents the Draft was given,
 * each one an entry `document:<name>` beside the pages: `drafted` with the pending draft, or `failed`
 * with ai_failed when the answer failed its schema or a gate twice; `superseded`, with no model asked
 * and nothing written, once a later Draft started. Unchanged pages and documents are the cached answer.
 * With neither a page nor a document (the website removed while the run fetched), fetch_failed, and
 * no model asked.
 */
export async function draftFromPages(run: DraftRun, context: DraftContext): Promise<RunResult> {
  const task = registeredTask();
  const read = await context.tenant(async () => {
    const pages = await draftPages(run);
    return pages && { pages, documents: await draftDocuments(run.companyKnowledgeId) };
  });
  if (read === null) return { status: "superseded", pages: 0 };
  const { pages, documents } = read;
  if (pages.length + documents.length === 0) {
    return context.tenant(() => recordDraft(run, { ok: false, code: "fetch_failed" }, 0));
  }
  // Only what the model reads, in the order read, each text whole as stored: the same pages and
  // documents hash the same (the cache).
  const input: DraftInput = { pages: [...pages, ...documents] };
  const call = { workspaceId: run.workspaceId, subjectRef: run.companyKnowledgeId, input };
  const result = await callAgent(task, call, context.call);
  let outcome: DraftOutcome = { ok: false, code: "ai_failed" };
  if (result.status === "ok") {
    const { modelId } = await agentModel(task);
    const { decisionRecordId, output } = result;
    const draft = { model: modelId, promptVersion: task.promptVersion, decisionRecordId };
    outcome = { ok: true, draft: { ...draft, fields: output } };
  }
  return context.tenant(() => recordDraft(run, outcome, pages.length));
}

/** The task the host registered at start (loadAgentTasks); never imported here (agents/). */
function registeredTask(): typeof draftCompanyKnowledgeTask {
  const task = registeredAgentTasks().get(DRAFT_COMPANY_KNOWLEDGE);
  if (task === undefined) throw new AppError(errors.draft_agent_not_loaded);
  return task as unknown as typeof draftCompanyKnowledgeTask;
}

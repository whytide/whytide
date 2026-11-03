// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox"), and its own
// subscriber, which starts a Draft's workflow in the worker (platform README "Workflows").
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";
import type { DraftRun } from "./domain/draft.ts";

export const events = defineEvents({
  /** A save changed the Company Knowledge: `version` is the record's new one. */
  "onboarding.company_knowledge_updated": z.strictObject({
    workspaceId: z.string(),
    version: z.number().int().positive(),
  }),
  /** A Draft from website started run `draftRunId`: the worker starts its workflow. */
  "onboarding.draft_requested": z.strictObject({
    workspaceId: z.string(),
    companyKnowledgeId: z.string(),
    draftRunId: z.string(),
  }),
});

/**
 * The start of a Draft's workflow (README "The website fetch"), by an id from its run: a second
 * delivery of the event starts no second run, as the starter answers `{ started: false }` for it.
 */
export function draftStart({ workspaceId, companyKnowledgeId, draftRunId }: DraftRun) {
  return {
    workflow: "onboarding_draft_company_knowledge",
    input: { workspaceId, companyKnowledgeId, draftRunId },
    workflowId: `onboarding.draft:${workspaceId}:${draftRunId}`,
  };
}

// The workspace is the delivery's tenant run, never the payload's: the starter does not compare them.
subscribe(events["onboarding.draft_requested"], async (payload) => {
  await startWorkflow(draftStart({ ...payload, workspaceId: currentTenant().workspaceId }));
});

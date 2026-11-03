// What the worker host loads of onboarding (core/apps/worker/docs/workflows.md): the Draft's
// workflow and its activities, the fetch, the drafter and their failure marks. Inputs carry ids only.
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
import { recordDraft, recordFetch } from "../domain/draft.ts";
import { type DraftContext, draftFromPages } from "../domain/drafter.ts";
import { fetchWebsite } from "./fetch-website.ts";

/** A Draft's run: the record and the run the Draft started (onboarding.draft_requested). */
export const draftInput = workflowInput.extend({
  companyKnowledgeId: z.string().min(1),
  draftRunId: z.string().min(1),
});

export const workflows = defineWorkflows({
  onboarding_draft_company_knowledge: { input: draftInput, taskQueue: DEFAULT_TASK_QUEUE },
});

export const activities = {
  /** Reads the website and writes its pages and status (README "The website fetch"). */
  onboarding_fetch_website: defineActivity({
    kind: "provider",
    input: draftInput,
    run: fetchWebsite,
  }),
  /** Once the fetch failed past its attempts: the run ends `failed`, fetch_failed. */
  onboarding_fetch_failed: defineActivity({
    kind: "db",
    input: draftInput,
    run: (run, context: ActivityContext<TenantClient>) =>
      context.tenant(() => recordFetch(run, { ok: false, code: "fetch_failed" })),
  }),
  /** Drafts the record from the pages the fetch read (README "The drafter"). */
  onboarding_draft_from_pages: defineActivity({
    kind: "ai",
    input: draftInput,
    run: (run, context: DraftContext) => draftFromPages(run, context),
  }),
  /** Once the drafter failed past its attempts: the run ends `failed`, draft_failed. */
  onboarding_draft_failed: defineActivity({
    kind: "db",
    input: draftInput,
    run: (run, context: ActivityContext<TenantClient>) =>
      context.tenant(() => recordDraft(run, { ok: false, code: "draft_failed" }, 0)),
  }),
};

export const schedules = defineSchedules([]);

// The drafter (README.md beside this file): the company's Company Knowledge and the admin's brief
// become a proposed ICP. A host's loadAgentTasks() imports this file from the sources while the worker
// runs the module from dist/, so it imports no registry of the module (index.ts, events.ts, ids.ts,
// errors.ts) and the module never imports it: the drafter's activity takes the task from the agent
// registry.
import { defineAgentTask } from "@whytide/ai";
import { DRAFT_PROFILE_GATES } from "../../domain/draft-gates.ts";
import {
  DRAFT_PROFILE,
  draftProfileInput,
  draftProfileOutput,
} from "../../schemas/draft-profile.ts";
import { settings } from "../../settings.ts";

export const draftProfileTask = defineAgentTask(
  {
    name: DRAFT_PROFILE,
    module: "icp",
    kind: "classification",
    model: settings.AI_MODEL_ICP_DRAFT_PROFILE,
    promptVersion: 2,
    inputSchema: draftProfileInput,
    outputSchema: draftProfileOutput,
    // Setup is free, as onboarding's draft: the cost event alone records the call.
    budget: { maxInputTokens: 40_000, maxOutputTokens: 6_000, maxCostCredits: 0 },
    tools: [],
    gates: DRAFT_PROFILE_GATES,
  },
  import.meta.url,
);

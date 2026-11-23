// The drafter (README.md beside this file): the pages a Draft read, then the documents it was given,
// become a Company Knowledge draft, each value with its page or document and a quote of it. A host's
// loadAgentTasks() imports this file from the sources while the worker runs the module from dist/,
// so it imports no registry of the module (index.ts, events.ts, ids.ts, errors.ts) and the module
// never imports it: the drafter's activity takes the task from the agent registry.
import { defineAgentTask } from "@whytide/ai";
import { DRAFT_GATES } from "../../domain/draft-gates.ts";
import {
  DRAFT_COMPANY_KNOWLEDGE,
  draftInput,
  draftOutput,
} from "../../schemas/draft-company-knowledge.ts";
import { settings } from "../../settings.ts";

export const draftCompanyKnowledgeTask = defineAgentTask(
  {
    name: DRAFT_COMPANY_KNOWLEDGE,
    module: "onboarding",
    kind: "classification",
    model: settings.AI_MODEL_ONBOARDING_DRAFT_COMPANY_KNOWLEDGE,
    promptVersion: 2,
    inputSchema: draftInput,
    outputSchema: draftOutput,
    // Every page and document whole: the largest Draft, ten pages and five documents of 50,000
    // three-byte characters, estimates at about 766,000 input tokens (README.md "Input"); the output
    // counts the model's thinking. Both within the 1M context of the current models. Not priced in
    // credits in alpha: the cost event alone records it.
    budget: { maxInputTokens: 800_000, maxOutputTokens: 16_000, maxCostCredits: 0 },
    tools: [],
    gates: DRAFT_GATES,
  },
  import.meta.url,
);

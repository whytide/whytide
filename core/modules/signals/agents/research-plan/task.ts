// The research plan agent (README.md beside this file; gamma-wr-040): at the start of a research run,
// the trade's own words by language, the source types to use and the queries to ask, written from what
// a member gave in the app. A host's loadAgentTasks() imports this file from the sources while the
// worker runs the module from dist/, so it imports no registry of the module (index.ts, events.ts,
// ids.ts, errors.ts) and the module never imports it: planResearchRun takes the task from the agent
// registry. Its gates, which refuse a part of the plan and keep the rest, run after the call
// (domain/research/checks.ts), not here: a task gate refuses the whole answer.
import { defineAgentTask } from "@whytide/ai";
import { signalsConfig } from "../../config.ts";
import {
  RESEARCH_PLAN,
  researchPlanInput,
  researchPlanOutput,
} from "../../schemas/research-plan.ts";

export const researchPlanTask = defineAgentTask(
  {
    name: RESEARCH_PLAN,
    module: "signals",
    kind: "generation",
    model: signalsConfig.AI_MODEL_SIGNALS_RESEARCH_PLAN,
    promptVersion: 4,
    inputSchema: researchPlanInput,
    outputSchema: researchPlanOutput,
    // Company Knowledge's texts and lists, an audience, the nine source types and up to 200 earlier
    // queries come to about 14,000 tokens at most, the source's Not a fit companies (100) about 3,000 more; the answer is 100 queries and 8 languages of words.
    budget: { maxInputTokens: 24_000, maxOutputTokens: 8_000, maxCostCredits: 0 },
    tools: [],
  },
  import.meta.url,
);

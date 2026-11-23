// The rating agent (README.md beside this file; gamma-p5-030): up to ten events against the offer,
// each its relevance, a one-line rationale and its intent class. A host's loadAgentTasks() imports
// this file from the sources while the worker runs the module from dist/, so it imports no registry
// of the module (index.ts, events.ts, ids.ts, errors.ts) and the module never imports it: rateEvents
// takes the task from the agent registry.
import { defineAgentTask } from "@whytide/ai";
import { signalsConfig } from "../../config.ts";
import { ratingsGate } from "../../domain/rate/checks.ts";
import {
  RATE_ENGAGEMENT,
  rateEngagementInput,
  rateEngagementOutput,
} from "../../schemas/rate-engagement.ts";

export const rateEngagementTask = defineAgentTask(
  {
    name: RATE_ENGAGEMENT,
    module: "signals",
    kind: "classification",
    model: signalsConfig.AI_MODEL_SIGNALS_RATE_ENGAGEMENT,
    promptVersion: 1,
    inputSchema: rateEngagementInput,
    outputSchema: rateEngagementOutput,
    budget: { maxInputTokens: 16_000, maxOutputTokens: 2_000, maxCostCredits: 0 },
    tools: [],
    gates: [ratingsGate],
  },
  import.meta.url,
);

// The planner (README.md beside this file): the angle, the facts and the call to action of a first
// LinkedIn message, from the dossier. A host's loadAgentTasks() imports this file from the sources
// while the worker runs the module from dist/, so it imports no registry of the module (index.ts,
// events.ts, ids.ts, errors.ts) and the module never imports it: writeDraft takes the task from the
// agent registry.
import { defineAgentTask } from "@whytide/ai";
import { PLAN_MESSAGE, planInput, planOutput } from "../../schemas/writer.ts";
import { settings } from "../../settings.ts";

export const planMessageTask = defineAgentTask(
  {
    name: PLAN_MESSAGE,
    module: "messaging",
    kind: "generation",
    model: settings.AI_MODEL_MESSAGING_PLAN_MESSAGE,
    promptVersion: 1,
    inputSchema: planInput,
    outputSchema: planOutput,
    // Not priced in credits in alpha: the cost event alone records it.
    budget: { maxInputTokens: 8_000, maxOutputTokens: 500, maxCostCredits: 0 },
    tools: [],
  },
  import.meta.url,
);

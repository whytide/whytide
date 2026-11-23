// The writer (README.md beside this file): the text of one LinkedIn message, a lead's first or a
// sequence step's, from the dossier and the planner's plan. A host's loadAgentTasks() imports this file from the sources while the
// worker runs the module from dist/, so it imports no registry of the module (index.ts, events.ts,
// ids.ts, errors.ts) and the module never imports it: writeDraft takes the task from the agent
// registry.
import { defineAgentTask } from "@whytide/ai";
import { WRITE_MESSAGE, writeInput, writeOutput } from "../../schemas/writer.ts";
import { settings } from "../../settings.ts";

export const writeMessageTask = defineAgentTask(
  {
    name: WRITE_MESSAGE,
    module: "messaging",
    kind: "generation",
    model: settings.AI_MODEL_MESSAGING_WRITE_MESSAGE,
    promptVersion: 3,
    inputSchema: writeInput,
    outputSchema: writeOutput,
    // Not priced in credits in alpha: the cost event alone records it.
    budget: { maxInputTokens: 8_000, maxOutputTokens: 1_500, maxCostCredits: 0 },
    tools: [],
  },
  import.meta.url,
);

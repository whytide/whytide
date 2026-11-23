// The email writer (README.md beside this file; gamma-p3-070): a first email's subject and body, or a
// follow-up's body, from the dossier and the planner's plan. A host's loadAgentTasks() imports this
// file from the sources while the worker runs the module from dist/, so it imports no registry of the
// module (index.ts, events.ts, ids.ts, errors.ts) and the module never imports it: writeDraft takes
// the task from the agent registry.
import { defineAgentTask } from "@whytide/ai";
import { WRITE_EMAIL, writeEmailInput, writeEmailOutput } from "../../schemas/writer.ts";
import { settings } from "../../settings.ts";

export const writeEmailTask = defineAgentTask(
  {
    name: WRITE_EMAIL,
    module: "messaging",
    kind: "generation",
    model: settings.AI_MODEL_MESSAGING_WRITE_EMAIL,
    promptVersion: 1,
    inputSchema: writeEmailInput,
    outputSchema: writeEmailOutput,
    // The LinkedIn writer's budget; not priced in credits: the cost event alone records it.
    budget: { maxInputTokens: 8_000, maxOutputTokens: 1_500, maxCostCredits: 0 },
    tools: [],
  },
  import.meta.url,
);

// The reply classifier (README.md beside this file): one stored reply and its thread's last messages,
// masked, to one of the 7 labels, a confidence and an out-of-office reply's return date. A host's
// loadAgentTasks() imports this file from the sources while the worker runs the module from dist/,
// so it imports no registry of the module (index.ts, events.ts, ids.ts, errors.ts) and the module
// never imports it: classifyReply takes the task from the agent registry.
import { defineAgentTask } from "@whytide/ai";
import { returnDateGate } from "../../domain/classify/checks.ts";
import { CLASSIFY_REPLY, classifyReplyInput, classifyReplyOutput } from "../../schemas/classify.ts";
import { settings } from "../../settings.ts";

export const classifyReplyTask = defineAgentTask(
  {
    name: CLASSIFY_REPLY,
    module: "inbox",
    kind: "classification",
    model: settings.AI_MODEL_INBOX_CLASSIFY_REPLY,
    promptVersion: 1,
    inputSchema: classifyReplyInput,
    outputSchema: classifyReplyOutput,
    budget: { maxInputTokens: 16_000, maxOutputTokens: 300, maxCostCredits: 0 },
    tools: [],
    gates: [returnDateGate],
  },
  import.meta.url,
);

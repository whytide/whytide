// The reply writer (README.md beside this file; inbox-reply-draft): the seller's next message in an
// inbox thread, from the dossier, the conversation and the member's brief. A host's loadAgentTasks()
// imports this file from the sources while the worker runs the module from dist/, so it imports no
// registry of the module (index.ts, events.ts, ids.ts, errors.ts) and the module never imports it:
// writeReply takes the task from the agent registry.
import { defineAgentTask } from "@whytide/ai";
import { WRITE_REPLY, writeReplyInput, writeReplyOutput } from "../../schemas/reply.ts";
import { settings } from "../../settings.ts";

export const writeReplyTask = defineAgentTask(
  {
    name: WRITE_REPLY,
    module: "messaging",
    kind: "generation",
    model: settings.AI_MODEL_MESSAGING_WRITE_REPLY,
    // 2: <request>, the caller's id of the request, so a new request is never answered from the cache.
    promptVersion: 2,
    inputSchema: writeReplyInput,
    outputSchema: writeReplyOutput,
    // The conversation's 24,000 bytes at most (8,000 tokens) above the writer's 8,000. Not priced in
    // credits: the cost event alone records it, as the other writers.
    budget: { maxInputTokens: 16_000, maxOutputTokens: 1_500, maxCostCredits: 0 },
    tools: [],
  },
  import.meta.url,
);

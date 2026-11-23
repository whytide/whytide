// The result-reading agent (README.md beside this file; gamma-wr-090): for one found company, the results
// of a search for its managers on LinkedIn that code kept, and for each the name and the role of the
// person as its title and snippet write them. A host's loadAgentTasks() imports this file from the
// sources while the worker runs the module from dist/, so it imports no registry of the module (index.ts,
// events.ts, ids.ts, errors.ts) and the module never imports it: the managers' step takes the task from
// the agent registry. Its gates, which refuse a part of the answer and keep the rest, run after the call
// (domain/research/managers-checks.ts), not here: a task gate refuses the whole answer.
import { defineAgentTask } from "@whytide/ai";
import { signalsConfig } from "../../config.ts";
import {
  RESEARCH_READ_RESULT,
  researchReadResultInput,
  researchReadResultOutput,
} from "../../schemas/research-read-result.ts";

export const researchReadResultTask = defineAgentTask(
  {
    name: RESEARCH_READ_RESULT,
    module: "signals",
    kind: "classification",
    model: signalsConfig.AI_MODEL_SIGNALS_RESEARCH_READ_RESULT,
    promptVersion: 1,
    inputSchema: researchReadResultInput,
    outputSchema: researchReadResultOutput,
    // Up to 20 results of a title (200 characters) and a snippet (500), and the company's name, come to
    // about 8,000 tokens in a script of three-byte characters; the answer is 20 people of a name and a role.
    budget: { maxInputTokens: 12_000, maxOutputTokens: 2_000, maxCostCredits: 0 },
    tools: [],
  },
  import.meta.url,
);

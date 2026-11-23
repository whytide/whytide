// The result-picking agent (README.md beside this file; gamma-wr-045): after a research run's searches,
// for each search the results worth reading, the likeliest first, chosen from their address, title and
// snippet. A host's loadAgentTasks() imports this file from the sources while the worker runs the
// module from dist/, so it imports no registry of the module (index.ts, events.ts, ids.ts, errors.ts)
// and the module never imports it: pickResearchResults takes the task from the agent registry.
import { defineAgentTask } from "@whytide/ai";
import { signalsConfig } from "../../config.ts";
import { picksGate } from "../../domain/research/checks.ts";
import {
  RESEARCH_PICK_RESULTS,
  researchPickInput,
  researchPickOutput,
} from "../../schemas/research-pick-results.ts";

export const researchPickResultsTask = defineAgentTask(
  {
    name: RESEARCH_PICK_RESULTS,
    module: "signals",
    kind: "classification",
    model: signalsConfig.AI_MODEL_SIGNALS_RESEARCH_PICK_RESULTS,
    promptVersion: 1,
    inputSchema: researchPickInput,
    outputSchema: researchPickOutput,
    // 50 results of a link, a 200-character title and a 500-character snippet, the member's focus and
    // the query come to about 20,000 tokens in a script of three-byte characters; the answer is numbers.
    budget: { maxInputTokens: 24_000, maxOutputTokens: 1_000, maxCostCredits: 0 },
    tools: [],
    gates: [picksGate],
  },
  import.meta.url,
);

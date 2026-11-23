// The page-reading agent (README.md beside this file; gamma-wr-046): for one page a research run read,
// what the page is and the companies it names. A host's loadAgentTasks() imports this file from the
// sources while the worker runs the module from dist/, so it imports no registry of the module (index.ts,
// events.ts, ids.ts, errors.ts) and the module never imports it: readResearchPageCompanies takes the
// task from the agent registry. Its gates, which refuse a part of the answer and keep the rest, run
// after the call (domain/research/read-checks.ts), not here: a task gate refuses the whole answer.
import { defineAgentTask } from "@whytide/ai";
import { signalsConfig } from "../../config.ts";
import {
  RESEARCH_READ_PAGE,
  researchReadInput,
  researchReadOutput,
} from "../../schemas/research-read-page.ts";

export const researchReadPageTask = defineAgentTask(
  {
    name: RESEARCH_READ_PAGE,
    module: "signals",
    kind: "classification",
    model: signalsConfig.AI_MODEL_SIGNALS_RESEARCH_READ_PAGE,
    promptVersion: 1,
    inputSchema: researchReadInput,
    outputSchema: researchReadOutput,
    // 20,000 characters of text, 100 links of 200 characters, the member's focus and the source
    // type's words come to 45,000 tokens at most in a script of three-byte characters; the answer is
    // 50 companies of a name, a link, a place, a line and a quote.
    budget: { maxInputTokens: 48_000, maxOutputTokens: 8_000, maxCostCredits: 0 },
    tools: [],
  },
  import.meta.url,
);

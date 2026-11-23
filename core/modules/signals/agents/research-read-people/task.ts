// The people-reading agent (README.md beside this file; gamma-wr-060): for one found company, the
// people its pages name with a role, each with the page they are on and, only as printed with them, a
// profile's link, an address at the company's domain and a place. A host's loadAgentTasks() imports this
// file from the sources while the worker runs the module from dist/, so it imports no registry of the
// module (index.ts, events.ts, ids.ts, errors.ts) and the module never imports it: takePeople takes the
// task from the agent registry. Its gates, which refuse a part of the answer and keep the rest, run after
// the call (domain/research/people-checks.ts), not here: a task gate refuses the whole answer.
import { defineAgentTask } from "@whytide/ai";
import { signalsConfig } from "../../config.ts";
import {
  RESEARCH_READ_PEOPLE,
  researchReadPeopleInput,
  researchReadPeopleOutput,
} from "../../schemas/research-read-people.ts";

export const researchReadPeopleTask = defineAgentTask(
  {
    name: RESEARCH_READ_PEOPLE,
    module: "signals",
    kind: "classification",
    model: signalsConfig.AI_MODEL_SIGNALS_RESEARCH_READ_PEOPLE,
    promptVersion: 2,
    inputSchema: researchReadPeopleInput,
    outputSchema: researchReadPeopleOutput,
    // 21 pages of 12,000 characters (50,000 in all, the run's own bound), their links and the company
    // come to about 45,000 tokens in a script of three-byte characters; the answer is 100 people of a
    // name, a role, a link, an address, a phone and a place.
    budget: { maxInputTokens: 60_000, maxOutputTokens: 12_000, maxCostCredits: 0 },
    tools: [],
  },
  import.meta.url,
);

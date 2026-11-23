// The people-picking agent (README.md beside this file; gamma-wr-060, rule 35): among the people a
// company's pages named, the ones whose role fits the audience's titles and seniorities, the best fit
// first, judged on the role text alone: its input holds no name, link or address. A host's
// loadAgentTasks() imports this file from the sources while the worker runs the module from dist/, so
// it imports no registry of the module (index.ts, events.ts, ids.ts, errors.ts) and the module never
// imports it: takePeople takes the task from the agent registry.
import { defineAgentTask } from "@whytide/ai";
import { signalsConfig } from "../../config.ts";
import { peoplePicksGate } from "../../domain/research/people-checks.ts";
import {
  RESEARCH_PICK_PEOPLE,
  researchPickPeopleInput,
  researchPickPeopleOutput,
} from "../../schemas/research-pick-people.ts";

export const researchPickPeopleTask = defineAgentTask(
  {
    name: RESEARCH_PICK_PEOPLE,
    module: "signals",
    kind: "classification",
    model: signalsConfig.AI_MODEL_SIGNALS_RESEARCH_PICK_PEOPLE,
    promptVersion: 1,
    inputSchema: researchPickPeopleInput,
    outputSchema: researchPickPeopleOutput,
    // 100 roles of 200 characters and the audience's 100 titles and levels come to about 15,000 tokens
    // in a script of three-byte characters; the answer is numbers.
    budget: { maxInputTokens: 18_000, maxOutputTokens: 1_000, maxCostCredits: 0 },
    tools: [],
    gates: [peoplePicksGate],
  },
  import.meta.url,
);

// The assessment agent (README.md beside this file): one anonymized person against the ICP's six
// criteria. A host's loadAgentTasks() imports this file from the sources while the worker runs the
// module from dist/, so it imports no registry of the module (index.ts, events.ts, ids.ts, errors.ts)
// and the module never imports it: assessPerson takes the task from the agent registry.
import { defineAgentTask } from "@whytide/ai";
import { qualificationConfig } from "../../config.ts";
import { criteriaGate } from "../../domain/assess/checks.ts";
import { ASSESS_FIT, assessFitInput, assessFitOutput } from "../../schemas/assess-fit.ts";

export const assessFitTask = defineAgentTask(
  {
    name: ASSESS_FIT,
    module: "qualification",
    kind: "classification",
    model: qualificationConfig.AI_MODEL_QUALIFICATION_ASSESS_FIT,
    promptVersion: 1,
    inputSchema: assessFitInput,
    outputSchema: assessFitOutput,
    budget: { maxInputTokens: 12_000, maxOutputTokens: 1_500, maxCostCredits: 1 },
    tools: [],
    gates: [criteriaGate],
  },
  import.meta.url,
);

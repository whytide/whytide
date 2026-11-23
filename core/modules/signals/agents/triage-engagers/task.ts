// The triage agent (README.md beside this file; signals-triage-ai): up to 25 staged candidates
// against the ICP's targeting, each skipped as a recruiter or a job seeker the ICP does not target,
// read first, or read. A host's loadAgentTasks() imports this file from the sources while the worker
// runs the module from dist/, so it imports no registry of the module (index.ts, events.ts, ids.ts,
// errors.ts) and the module never imports it: triageCandidates takes the task from the agent registry.
import { defineAgentTask } from "@whytide/ai";
import { signalsConfig } from "../../config.ts";
import { decisionsGate } from "../../domain/triage/checks.ts";
import {
  TRIAGE_ENGAGERS,
  triageEngagersInput,
  triageEngagersOutput,
} from "../../schemas/triage-engagers.ts";

export const triageEngagersTask = defineAgentTask(
  {
    name: TRIAGE_ENGAGERS,
    module: "signals",
    kind: "classification",
    model: signalsConfig.AI_MODEL_SIGNALS_TRIAGE_ENGAGERS,
    promptVersion: 1,
    inputSchema: triageEngagersInput,
    outputSchema: triageEngagersOutput,
    budget: { maxInputTokens: 24_000, maxOutputTokens: 2_000, maxCostCredits: 0 },
    tools: [],
    gates: [decisionsGate],
  },
  import.meta.url,
);

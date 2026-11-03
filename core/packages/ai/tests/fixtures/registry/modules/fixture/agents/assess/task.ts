// A fixture module's agent task, as a module's agents/<agent>/task.ts declares one (tests/registry.test.ts),
// with a gate (tests/call.test.ts, evals/fixture.assess): a `met` verdict needs evidence.
import { z } from "zod";
import { defineAgentTask } from "../../../../../../../index.ts";

export const assessTask = defineAgentTask(
  {
    name: "fixture.assess",
    module: "fixture",
    kind: "classification",
    model: undefined,
    promptVersion: 1,
    inputSchema: z.object({ profile: z.string(), evidence: z.array(z.string()) }),
    outputSchema: z.object({ verdict: z.enum(["met", "not_met"]) }),
    budget: { maxInputTokens: 400, maxOutputTokens: 200, maxCostCredits: 1 },
    tools: [],
    gates: [
      (output, input) => ({
        gate: "evidence",
        issues:
          output.verdict === "met" && input.evidence.length === 0
            ? [{ path: "verdict", message: "met needs at least one evidence item" }]
            : [],
      }),
    ],
  },
  import.meta.url,
);

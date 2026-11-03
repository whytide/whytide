// A second task named fixture.assess (tests/registry.test.ts): loading it after the first fails.
import { z } from "zod";
import { defineAgentTask } from "../../../../../../../index.ts";

defineAgentTask(
  {
    name: "fixture.assess",
    module: "fixture",
    kind: "generation",
    promptVersion: 1,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    budget: { maxInputTokens: 1, maxOutputTokens: 1, maxCostCredits: 0 },
    tools: [],
  },
  import.meta.url,
);

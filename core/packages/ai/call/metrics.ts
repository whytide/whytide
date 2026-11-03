// The agent calls' metrics (README "Metrics"), by task: each call's outcome, its retries, the tokens
// and the cost its cost events carry. A model's words never reach a metric; the task's name does.
import { defineMetrics } from "@whytide/platform";

export const aiMetrics = defineMetrics(
  {
    "ai.calls": {
      kind: "counter",
      labels: ["task", "outcome"],
      unit: "{call}",
      description:
        "Agent calls, by task and outcome (ok, ai_failed, cached, or error when it threw)",
    },
    "ai.retries": {
      kind: "counter",
      labels: ["task"],
      unit: "{attempt}",
      description: "Attempts after a call's first, each with the failure appended",
    },
    "ai.tokens": {
      kind: "counter",
      labels: ["task", "kind"],
      unit: "{token}",
      description: "Tokens the model reported, by task and kind (input, output)",
    },
    "ai.cost": {
      kind: "counter",
      labels: ["task"],
      description: "What the calls cost, the cost events' unit_cost, in the price list's currency",
    },
  },
  import.meta.url,
);

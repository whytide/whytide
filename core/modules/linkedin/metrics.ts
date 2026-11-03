// linkedin's metric (core/packages/platform/README.md "Metrics"): every action-log row, by kind and
// outcome, adding its count. No label carries an account, a post or a person.
import { defineMetrics } from "@whytide/platform";

export const linkedinMetrics = defineMetrics(
  {
    "linkedin.actions": {
      kind: "counter",
      labels: ["kind", "outcome"],
      unit: "{action}",
      description:
        "Sender-account actions logged, by kind and outcome, each adding its count: reads reserved or made, status checks",
    },
  },
  import.meta.url,
);

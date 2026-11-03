// credits' metrics (core/packages/platform/README.md "Metrics"), on the dashboard
// deploy/observability/dashboards/credits.json.
import { defineMetrics } from "@whytide/platform";

export const creditsMetrics = defineMetrics(
  {
    "credits.usage": {
      kind: "counter",
      labels: ["outcome"],
      unit: "{usage}",
      description:
        "Credit usages by outcome: reserved, refused (insufficient), committed, released, expired by the sweep",
    },
  },
  import.meta.url,
);

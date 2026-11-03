// The providers' metric (README "Metrics"): every call through a port's boundary, by port, adapter,
// method and outcome, `ok` or the code the boundary threw (`llm_rate_limited`, `<prefix>_error_unmapped`).
import { defineMetrics } from "@whytide/platform";

export const providerMetrics = defineMetrics(
  {
    "providers.calls": {
      kind: "counter",
      labels: ["port", "adapter", "method", "outcome"],
      unit: "{call}",
      description:
        "Calls through a port's boundary, by port, adapter, method and outcome (ok or a code)",
    },
  },
  import.meta.url,
);

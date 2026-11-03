// The api host's metrics (README "Metrics"): each request when its response closes, by method, route
// template ("unmatched" when no route matched), status and error code ("none" without one); its
// duration; and the rate limits' decisions. Never a URL, an id or a header.
import { defineMetrics } from "@whytide/platform";

export const apiMetrics = defineMetrics(
  {
    "api.requests": {
      kind: "counter",
      labels: ["method", "route", "status", "code"],
      unit: "{request}",
      description: "Requests answered, by method, route template, status and error code",
    },
    "api.request.duration": {
      kind: "histogram",
      labels: ["method", "route"],
      unit: "s",
      description: "Time from the request's first middleware to its response's close",
    },
    "api.rate_limit.decisions": {
      kind: "counter",
      labels: ["kind", "outcome"],
      unit: "{request}",
      description:
        "Requests counted by a rate limit, by kind and outcome (allowed, limited, unavailable)",
    },
  },
  import.meta.url,
);

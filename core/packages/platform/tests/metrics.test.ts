// Unit tests of the metric registry (alpha-p10-060): the label allow-list refuses `email`,
// `person_id` and any label off the list, and holds no key of the PII registry or id; a name declared
// twice fails naming both files; a recorder passes on the declared labels only and, under
// APP_ENV=test, keeps what it emitted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { piiKeys } from "../logging/pii.ts";
import { defineMetrics, metricLabels, recordedMetrics } from "../telemetry/metrics.ts";
import { throwsCode } from "../testing/index.ts";

test("a metric with a label named email or person_id fails registration, as does a label off the list", () => {
  for (const label of ["email", "person_id", "url", "workspace_id", "name"]) {
    const definition = {
      [`fixture.refused_${label}`]: { kind: "counter", labels: [label] },
    } as const;
    throwsCode(() => defineMetrics(definition, import.meta.url), "metric_label_refused");
  }
  const unsafe = metricLabels.filter((label) => piiKeys.includes(label) || /_ids?$/.test(label));
  assert.deepEqual(unsafe, []);
});

test("a name declared twice fails naming both files; a recorder keeps the declared labels only", () => {
  const first = defineMetrics(
    { "fixture.calls": { kind: "counter", labels: ["outcome"] } },
    "file:///first/metrics.ts",
  );
  throwsCode(
    () => defineMetrics({ "fixture.calls": { kind: "gauge", labels: [] } }, "file:///second.ts"),
    "duplicate_metric",
  );
  throwsCode(
    () => defineMetrics({ "Fixture calls": { kind: "counter", labels: [] } }, import.meta.url),
    "invalid_metric",
  );
  first["fixture.calls"].add(1, { outcome: "ok", undeclared: "dropped" } as { outcome: string });
  assert.deepEqual(recordedMetrics().get("fixture.calls"), [{ outcome: "ok" }]);
});

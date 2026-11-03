// pnpm observability:check end to end (alpha-p10-060), on a tree written here: it fails on a
// dashboard that queries a metric no defineMetrics declares, on a declared metric no test run
// emitted, and on a recorded label value shaped like an email, a URL or an id, naming the label and
// never the value; once the three agree it passes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const CHECK = join(import.meta.dirname, "..", "telemetry", "observability-check.ts");
const METRICS = `defineMetrics({
  "x.calls": { kind: "counter", labels: ["route", "code", "task"] },
  "x.lag": { kind: "gauge", labels: [], unit: "s" },
}, import.meta.url);`;

function write(root: string, path: string, content: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  const text = typeof content === "string" ? content : JSON.stringify(content);
  writeFileSync(join(root, path), text);
}

const dashboard = (expr: string) => ({ panels: [{ title: "Calls", targets: [{ expr }] }] });

test("the check fails on an unknown metric, an unemitted one and a recorded email, URL or id", () => {
  const root = mkdtempSync(join(tmpdir(), "observability-check-"));
  const run = () => spawnSync(process.execPath, [CHECK, "--root", root], { encoding: "utf8" });
  try {
    write(root, "core/packages/x/metrics.ts", METRICS);
    const known = "sum(rate(x_calls_total[5m])) by (route) / on() max(x_lag_seconds)";
    write(root, "deploy/observability/dashboards/x.json", dashboard(`${known} + y_unknown_total`));
    write(root, ".tmp/metrics/run.json", {
      "x.calls": [
        { route: "/v1/x/:id", code: "synthetic@example.com" },
        { route: "https://x.example/a" },
        { task: "per_01JAB3K5ZQ7W9R2M4T6V8X0Y1C" },
        { route: "/v1/x/ws_0f8e7d6c-5b4a-4321-8fed-cba987654321" },
      ],
    });
    const failed = run();
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stdout, /x\.json: "Calls" queries y_unknown_total, which no defineMetrics/);
    assert.match(failed.stdout, /metrics\.ts: x\.lag was emitted by no test run/);
    assert.doesNotMatch(failed.stdout, /x\.calls was emitted by no test run/);
    assert.match(failed.stdout, /the label code carried a value shaped like an email/);
    assert.match(failed.stdout, /the label route carried a value shaped like a URL/);
    assert.match(failed.stdout, /the label task carried a value shaped like an id/);
    assert.match(failed.stdout, /the label route carried a value shaped like an id/);
    assert.doesNotMatch(failed.stdout, /example\.com|per_01/);

    write(root, "deploy/observability/dashboards/x.json", dashboard(known));
    write(root, ".tmp/metrics/run.json", { "x.calls": [{ route: "/v1/x/:id" }], "x.lag": [{}] });
    const passed = run();
    assert.equal(passed.status, 0, passed.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

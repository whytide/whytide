// `pnpm -F deploy test:observability` (docs/observability.md), on the shared stack with the
// observability profile running and this worktree's slice: Grafana holds the four dashboards and the
// five alert rules, provisioned at its start; with this worktree's api and worker exporting to the
// container, their smoke tests put data on the api and worker panels; one outbox row of an event no
// module declares, dead-lettered by the worker at its first attempt, fires "Dead letters above zero".
// The script builds the api and the worker first. The row is the test's own and deleted after it.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

type Rule = { readonly uid: string; readonly state: string };
type Dashboard = { readonly panels: { title: string; targets: { expr: string }[] }[] };

const root = join(import.meta.dirname, "..", "..");
const project = process.env.COMPOSE_PROJECT_NAME || "whytide";
const EVENT = "observability_test.unknown";
const row = `obs_${randomUUID()}`;
const children: ChildProcess[] = [];
let grafana = "";
let migrated = false;

/** The localhost address Compose published for a port of the observability container. */
function published(port: number): string {
  const container = `${project}-otel-lgtm`;
  try {
    return execFileSync("docker", ["port", container, `${port}/tcp`], { encoding: "utf8" })
      .split("\n")[0]
      .trim();
  } catch {
    throw new Error(`${container} is not running: pnpm stack:up --profile observability`);
  }
}

/** A statement on the slice's database, through the stack's own psql. Constants only. */
function psql(sql: string): string {
  const database = decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").pathname.slice(1));
  const args = ["exec", `${project}-postgres`, "psql", "-U", "postgres", "-d", database];
  return execFileSync("docker", [...args, "-v", "ON_ERROR_STOP=1", "-Atc", sql], {
    encoding: "utf8",
  }).trim();
}

async function grafanaGet<T>(path: string): Promise<T> {
  const res = await fetch(new URL(path, grafana), { signal: AbortSignal.timeout(10_000) });
  assert.equal(res.status, 200, `GET ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

/** Asks `probe` every second until it says yes; fails naming `what` after `ms`. */
async function until(what: string, ms: number, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe().catch(() => false))) {
    if (Date.now() > deadline) assert.fail(`waited ${ms / 1000} s for ${what}`);
    await sleep(1_000);
  }
}

function host(app: "api" | "worker", args: string[], env: Record<string, string> = {}): void {
  const otlp = `http://${published(4318)}`;
  const child = spawn(process.execPath, args, {
    cwd: join(root, "core", "apps", app),
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: otlp,
      OTEL_METRIC_EXPORT_INTERVAL: "1000",
      ...env,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(child);
}

const healthy = async (url: string) =>
  (await fetch(url, { signal: AbortSignal.timeout(5_000) })).status === 200;
const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));

before(async () => {
  grafana = `http://${published(3000)}`;
  host("api", ["--enable-source-maps", "dist/src/main.js"]);
  // The api migrates the slice's database at its start; the worker then polls its outbox.
  await until("the api's /health", 120_000, () =>
    healthy(`http://127.0.0.1:${process.env.API_PORT}/health`),
  );
  migrated = true;
  psql(`DELETE FROM outbox WHERE event_name = '${EVENT}'`); // a crashed run's row, if any
  host("worker", ["src/main.ts"], { OUTBOX_MAX_ATTEMPTS: "1" });
  await until("the worker's /health", 120_000, () =>
    healthy(`http://127.0.0.1:${process.env.WORKER_HEALTH_PORT}/health`),
  );
});

after(async () => {
  for (const child of children) child.kill("SIGTERM");
  await Promise.race([Promise.all(children.map(exited)), sleep(15_000)]);
  for (const child of children) child.kill("SIGKILL");
  if (migrated) psql(`DELETE FROM outbox WHERE event_name = '${EVENT}'`);
});

test("the profile provisions the four dashboards and the five alert rules", async () => {
  const found = await grafanaGet<{ uid: string }[]>("/api/search?type=dash-db&tag=whytide");
  const uids = ["whytide-ai", "whytide-api", "whytide-providers", "whytide-worker"];
  assert.deepEqual(found.map((each) => each.uid).sort(), uids);
  const rules = await grafanaGet<Rule[]>("/api/v1/provisioning/alert-rules");
  const ruleUids = ["ai-failed", "dead-letters", "outbox-lag", "provider-errors", "worker-health"];
  assert.deepEqual(
    rules.map((rule) => rule.uid).sort(),
    ruleUids.map((uid) => `whytide-${uid}`),
  );
});

test("after the smoke tests the api and the worker dashboards show data", async () => {
  for (const app of ["api", "worker"]) {
    const smoke = spawnSync("pnpm", ["-F", app, "smoke"], { cwd: root, encoding: "utf8" });
    assert.equal(smoke.status, 0, `${app} smoke: ${smoke.stdout}${smoke.stderr}`);
  }
  const panels: Record<string, string[]> = {
    api: ["Requests per second, by route", "Latency p95, by route"],
    worker: [
      "Workflow runs, by workflow and outcome",
      "Worker health (1 ok, 0 failing)",
      "Outbox lag: the oldest due row's wait",
    ],
  };
  for (const [name, titles] of Object.entries(panels)) {
    const file = join(import.meta.dirname, "..", "observability", "dashboards", `${name}.json`);
    const dashboard = JSON.parse(readFileSync(file, "utf8")) as Dashboard;
    for (const title of titles) {
      const panel = dashboard.panels.find((each) => each.title === title);
      const expr = (panel?.targets[0]?.expr ?? "").replaceAll("$__rate_interval", "1m");
      const path = `/api/datasources/proxy/uid/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`;
      await until(`data on "${title}"`, 90_000, async () => {
        const body = await grafanaGet<{ data: { result: unknown[] } }>(path);
        return body.data.result.length > 0;
      });
    }
  }
});

test("one dead-lettered outbox row fires the dead letters alert", async () => {
  const state = async () => {
    const body = await grafanaGet<{ data: { groups: { rules: Rule[] }[] } }>(
      "/api/prometheus/grafana/api/v1/rules",
    );
    const rules = body.data.groups.flatMap((group) => group.rules);
    return rules.find((rule) => rule.uid === "whytide-dead-letters")?.state;
  };
  await until(
    "the dead letters alert at rest",
    120_000,
    async () => (await state()) === "inactive",
  );
  psql(
    `INSERT INTO outbox (id, workspace_id, event_name, payload) VALUES ('${row}', 'ws_observability_test', '${EVENT}', '{}')`,
  );
  const dead = `SELECT count(*) FROM outbox WHERE id = '${row}' AND dead_at IS NOT NULL`;
  await until("the row dead-lettered", 30_000, async () => psql(dead) === "1");
  await until("the dead letters alert firing", 120_000, async () => (await state()) === "firing");
});

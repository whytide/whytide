// The end-to-end test of alpha-p1-030: the package used as a host uses it. Config boots from a
// fixture environment; pino logs to a buffer with the redaction, the context and the active span's
// ids; telemetry runs in a child host against an OTLP receiver this test starts: with the endpoint
// unset nothing connects anywhere, with it set a span and a log arrive with the same trace id, and
// no URL's query arrives, inbound or outbound.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const platform = await import("../index.ts");

test("config boots from a fixture environment: defaults, secrets, the failing variable's name", () => {
  const env = {
    APP_ENV: "test",
    DATABASE_URL: "postgresql://app@127.0.0.1:5432/app",
    SIGNING_SECRET: "fixture",
    OPTIONAL_URL: "",
  };
  const shape = {
    APP_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.string().default("info"),
    DATABASE_URL: z.url(),
    SIGNING_SECRET: platform.secret(z.string().min(1)),
    OPTIONAL_URL: z.url().optional(),
  };
  const config = platform.defineConfig("tests/fixture", shape, env);
  assert.equal(config.APP_ENV, "test");
  assert.equal(config.LOG_LEVEL, "info");
  assert.equal(config.OPTIONAL_URL, undefined);
  assert.equal(config.SIGNING_SECRET, "fixture");
  assert.deepEqual(Object.keys(config), ["APP_ENV", "LOG_LEVEL", "DATABASE_URL"]);
  assert.ok(Object.isFrozen(config));
  assert.throws(
    () =>
      platform.defineConfig("tests/fixture", shape, { APP_ENV: "prod", DATABASE_URL: "not a url" }),
    (error: unknown) => {
      assert.ok(platform.isAppError(error) && error.code === "config_invalid");
      const variables = (error.details as { variables: string[] }).variables.map(
        (v) => v.split(":")[0],
      );
      assert.deepEqual(variables, ["APP_ENV", "DATABASE_URL", "SIGNING_SECRET"]);
      assert.doesNotMatch(JSON.stringify(error.details), /not a url/);
      return true;
    },
  );
  assert.deepEqual(Object.keys(platform.platformConfig), [
    "APP_ENV",
    "LOG_LEVEL",
    "DEFAULT_LOCALE",
  ]);
});

test("logs go through pino to a buffer with redaction, the context and the active span's ids", async () => {
  const logs = platform.collectLogs();
  const log = platform.createLogger({ destination: logs.destination });
  const telemetry = platform.startTelemetry({ serviceName: "core-test" });
  assert.equal(telemetry.exporting, false);
  const person = platform.synthetic("core").person();
  let traceId = "";
  await platform.withLogContext({ workspace_id: "wsp_core", actor: "usr_core" }, () =>
    platform.withSpan("core.work", { workspace_id: "wsp_core" }, (span) => {
      traceId = span.spanContext().traceId;
      log.info({ person, lead_count: 2 }, "qualified");
      log.info({ lead_id: "lead_x", duration_ms: 5 }, "done");
    }),
  );
  await telemetry.shutdown();
  const [first, second] = logs.lines();
  assert.ok(first && second);
  assert.match(traceId, /^[0-9a-f]{32}$/);
  assert.equal(first.trace_id, traceId);
  assert.match(String(first.span_id), /^[0-9a-f]{16}$/);
  assert.equal(first.workspace_id, "wsp_core");
  assert.equal(first.actor, "usr_core");
  const { company, ...personal } = person;
  assert.deepEqual(first.person, {
    ...Object.fromEntries(Object.keys(personal).map((k) => [k, "[redacted]"])),
    company,
  });
  const findings = platform.checkLogLines(logs.raw);
  assert.match(findings.join("\n"), /line 1.*"person".*not allowed/);
  assert.ok(
    findings.every((f) => f.startsWith("line 1")),
    findings.join("\n"),
  );
});

type Report = {
  exporting: boolean;
  traceId: string;
  connects: string[];
  lines: Record<string, unknown>[];
};
type Received = { url: string; body: Record<string, unknown> };

const host = fileURLToPath(new URL("./fixtures/telemetry/host.ts", import.meta.url));
const queries = fileURLToPath(new URL("./fixtures/telemetry/queries.ts", import.meta.url));

async function runHost<T = Report>(env: Record<string, string>, file = host): Promise<T> {
  const childEnv = { ...process.env, ...env };
  if (!("OTEL_EXPORTER_OTLP_ENDPOINT" in env)) delete childEnv.OTEL_EXPORTER_OTLP_ENDPOINT;
  const child = spawn(process.execPath, [file], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(exit, 0, `the fixture host failed:\n${err}`);
  const last = out.trim().split("\n").at(-1);
  assert.ok(last, `no report from the fixture host:\n${err}`);
  return JSON.parse(last) as T;
}

async function startReceiver() {
  const received: Received[] = [];
  let connections = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({ url: request.url ?? "", body: JSON.parse(body) as Record<string, unknown> });
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    received,
    connections: () => connections,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("with OTEL_EXPORTER_OTLP_ENDPOINT unset nothing connects anywhere, and ids still flow into the logs", async () => {
  const receiver = await startReceiver();
  try {
    const report = await runHost({});
    assert.equal(report.exporting, false);
    assert.deepEqual(report.connects, []);
    assert.equal(receiver.connections(), 0);
    assert.equal(receiver.received.length, 0);
    assert.equal(report.lines[0]?.trace_id, report.traceId);
  } finally {
    await receiver.close();
  }
});

test("with it set to a local collector, a span and a log arrive there with matching trace ids", async () => {
  const receiver = await startReceiver();
  try {
    const report = await runHost({
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${receiver.port}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    });
    assert.equal(report.exporting, true);
    assert.ok(report.connects.length > 0);
    assert.ok(
      report.connects.every((c) => c === `127.0.0.1:${receiver.port}`),
      report.connects.join(", "),
    );
    const spans = receiver.received.filter((r) => r.url === "/v1/traces").flatMap(spansOf);
    const span = spans.find((s) => s.name === "fixture.work");
    assert.ok(span, `no span fixture.work among ${JSON.stringify(spans)}`);
    assert.equal(span.traceId, report.traceId);
    assert.deepEqual(
      span.attributes.map((a) => a.key),
      ["workspace_id"],
    );
    const records = receiver.received.filter((r) => r.url === "/v1/logs").flatMap(recordsOf);
    const record = records.find((r) => r.body?.stringValue === "inside");
    assert.ok(record, `no log record "inside" among ${JSON.stringify(records)}`);
    assert.equal(record.traceId, report.traceId);
    assert.equal(report.lines[0]?.trace_id, report.traceId);
  } finally {
    await receiver.close();
  }
});

type Span = {
  name: string;
  kind: number;
  traceId: string;
  attributes: { key: string; value: { stringValue?: string } }[];
};
type Record_ = { traceId?: string; body?: { stringValue?: string } };
type Scoped<K extends string, T> = { [key in K]: T[] };

test("no query reaches the collector: an inbound request's, an outbound one's, a NestJS request span's", async () => {
  const receiver = await startReceiver();
  try {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${receiver.port}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    };
    type Queries = { status: number; port: number; remoteTrace: string };
    const report = await runHost<Queries>(env, queries);
    assert.equal(report.status, 200);
    assert.doesNotMatch(JSON.stringify(receiver.received), /t0ken|a=b|url\.query/);
    const spans = receiver.received.filter((r) => r.url === "/v1/traces").flatMap(spansOf);
    const value = (span: Span | undefined, key: string) =>
      span?.attributes.find((a) => a.key === key)?.value.stringValue;
    const urls = (span: Span | undefined) =>
      ["url.full", "url.original", "http.target", "http.url"].map((key) => value(span, key));
    const local = spans.filter((s) => s.traceId !== report.remoteTrace);
    const inbound = local.find((s) => s.kind === 2); // SPAN_KIND_SERVER
    const outbound = local.find((s) => s.kind === 3); // SPAN_KIND_CLIENT
    assert.deepEqual(
      [value(inbound, "url.path"), value(outbound, "url.full")],
      ["/x", `http://127.0.0.1:${report.port}/x`],
    );
    assert.deepEqual(urls(local.find((s) => s.kind === 1)), [
      "/x",
      "/x",
      "/x",
      "http://127.0.0.1/x",
    ]);
    // The caller's traceparent said "not sampled": the server span and the request span are
    // recorded all the same, and the raw target's fragment is cut too.
    const remote = spans.filter((s) => s.traceId === report.remoteTrace);
    assert.deepEqual(remote.map((s) => s.kind).sort(), [1, 2]);
    assert.deepEqual(urls(remote.find((s) => s.kind === 1)), [
      "/raw",
      "/raw",
      "/raw",
      "http://127.0.0.1/raw",
    ]);
  } finally {
    await receiver.close();
  }
});

function spansOf(received: Received): Span[] {
  const resource = received.body.resourceSpans as Scoped<"scopeSpans", Scoped<"spans", Span>>[];
  return resource.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
}

function recordsOf(received: Received): Record_[] {
  const resource = received.body.resourceLogs as Scoped<
    "scopeLogs",
    Scoped<"logRecords", Record_>
  >[];
  return resource.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords));
}

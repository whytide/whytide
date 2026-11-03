// A minimal host for tests/core.test.ts, run as a child process: it counts every outgoing TCP
// connection, starts telemetry the way a host does (the hook, the SDK, then the instrumented
// modules), logs inside a span and prints a JSON report as its last stdout line.
import net from "node:net";
import { startTelemetry, withSpan } from "../../../telemetry/index.ts";

const connects: string[] = [];
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  // net.createConnection hands over its normalized [options, callback]; a plain call, the options.
  const first = Array.isArray(args[0]) ? (args[0][0] as unknown) : args[0];
  const target = first as { host?: string; hostname?: string; port?: number } | undefined;
  connects.push(`${target?.host ?? target?.hostname ?? "?"}:${target?.port ?? "?"}`);
  return Reflect.apply(connect, this, args) as net.Socket;
} as typeof net.Socket.prototype.connect;

const telemetry = startTelemetry({ serviceName: "fixture-host" });
const { createLogger } = await import("../../../logging/index.ts");
const { collectLogs } = await import("../../../testing/index.ts");
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
let traceId = "";
await withSpan(
  "fixture.work",
  { workspace_id: "wsp_fixture", email: "fixture@example.com" },
  (span) => {
    traceId = span.spanContext().traceId;
    log.info({ workspace_id: "wsp_fixture" }, "inside");
  },
);
await telemetry.shutdown();
const report = { exporting: telemetry.exporting, traceId, connects, lines: logs.lines() };
process.stdout.write(`${JSON.stringify(report)}\n`);

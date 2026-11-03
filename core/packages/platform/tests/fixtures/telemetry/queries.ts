// A host for tests/core.test.ts, run as a child process: telemetry starts first, so node:http loads
// instrumented; then one request with a query, /x?token=t0ken&a=b, goes out to a server of its own,
// an outbound and an inbound span, and the handler starts a span the way NestJS's instrumentation
// starts its request span, the request's path and query as url.full (and as the other URL
// attributes). A second request, written on a socket, sends the target /raw#t0ken5 with a
// traceparent whose flags say "not sampled". The last stdout line is a JSON report.
import type { AddressInfo } from "node:net";
import { trace } from "@opentelemetry/api";
import { startTelemetry } from "../../../telemetry/index.ts";

const remoteTrace = "0af7651916cd43dd8448eb211c80319c";
const telemetry = startTelemetry({ serviceName: "fixture-queries" });
const http = await import("node:http");
const net = await import("node:net");
const server = http.createServer((request, response) => {
  const target = request.url ?? "";
  const attributes = {
    "url.full": target,
    "url.original": target,
    "http.target": target,
    "http.url": `http://127.0.0.1${target}`,
  };
  trace.getTracer("fixture").startSpan("FixtureController.handle", { attributes }).end();
  response.end("ok");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
// A local server of the test's own, as a vendor SDK's request would go out: fetchSafe suppresses
// its own spans, so it cannot stand in for one.
const status = await new Promise<number | undefined>((resolve, reject) => {
  http
    .get(`http://127.0.0.1:${port}/x?token=t0ken&a=b`, (response) => {
      response.resume().on("end", () => resolve(response.statusCode));
    })
    .on("error", reject);
});
const head = `traceparent: 00-${remoteTrace}-b7ad6b7169203331-00\r\nConnection: close`;
await new Promise<void>((resolve, reject) => {
  const socket = net.connect(port, "127.0.0.1", () => {
    socket.write(`GET /raw#t0ken5 HTTP/1.1\r\nHost: 127.0.0.1\r\n${head}\r\n\r\n`);
  });
  socket.resume().on("end", resolve).on("error", reject);
});
server.close();
await telemetry.shutdown();
process.stdout.write(`${JSON.stringify({ status, port, remoteTrace })}\n`);

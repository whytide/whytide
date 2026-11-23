// The marker check's host (url.test.ts), a child process run as a host runs: the platform's telemetry
// started first, exporting to the test's OTLP receiver, then the adapter. It posts one alert per
// answer the test's channel queued (MARKER_SENDS) and one to a closed port, each in a caller's span,
// then starts the adapter on each URL of MARKER_REFUSED; it logs every failure as a caller logs it
// and prints them all, inspected whole. The channel's path, its answers and the refused URLs carry
// the marker, which the test looks for in everything this run wrote or exported.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { startTelemetry } from "@whytide/platform/telemetry";

const telemetry = startTelemetry({ serviceName: "alerts-marker-check" });
const { createLogger, withSpan } = await import("@whytide/platform");
const { bindPort } = await import("../../../_pattern/index.ts");
const { alertsPort } = await import("../../port.ts");
const { webhookAdapter } = await import("../index.ts");

const variable = (name: string) => process.env[name] ?? assert.fail(`${name} is not set`);
const logger = createLogger();
const failures: unknown[] = [];
const failed = (error: unknown) => {
  failures.push(error);
  logger.error({ err: error }, "alert failed");
};
const attributes = { provider: webhookAdapter.name };
const started = () =>
  withSpan("alerts.start", attributes, () =>
    bindPort(alertsPort, webhookAdapter.create(), { adapter: webhookAdapter.name }),
  );
type Alerts = Awaited<ReturnType<typeof started>>;
const send = (alerts: Alerts) =>
  withSpan("alerts.send", attributes, () => alerts.send({ text: "[test] marker check" })).catch(
    failed,
  );

const alerts = await started();
for (let sent = 0; sent < Number(variable("MARKER_SENDS")); sent += 1) await send(alerts);
process.env.ALERTS_WEBHOOK_URL = variable("MARKER_CLOSED_URL");
await send(await started());
for (const url of JSON.parse(variable("MARKER_REFUSED")) as string[]) {
  process.env.ALERTS_WEBHOOK_URL = url;
  await started().then(() => assert.fail("the URL was to be refused"), failed);
}
await telemetry.shutdown();
const printed = inspect(failures, { depth: Number.POSITIVE_INFINITY, showHidden: true });
process.stdout.write(`${JSON.stringify({ failures: failures.length, printed })}\n`);

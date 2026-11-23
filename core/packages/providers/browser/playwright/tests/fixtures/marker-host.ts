// The marker check's host (../contract.test.ts), a child process run as a host runs: the platform's
// telemetry started first, exporting to the test's OTLP receiver, then the adapter on the service at
// MARKER_SERVICE, with the test site's hosts and names. It renders each URL of MARKER_URLS in a
// caller's span, logs every failure as a caller logs it, and prints the failures, inspected whole,
// with how many pages rendered; never a rendered page's text. The URLs and the pages carry the
// marker, which the test looks for in everything this run wrote or exported.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { startTelemetry } from "@whytide/platform/telemetry";

const telemetry = startTelemetry({ serviceName: "browser-marker-check" });
const { createLogger, withSpan } = await import("@whytide/platform");
const { bindPort } = await import("../../../../_pattern/index.ts");
const { browserPort } = await import("../../../port.ts");
const { playwrightBrowser } = await import("../../index.ts");
const { namesResolver } = await import("../site.ts");

const variable = (name: string) => process.env[name] ?? assert.fail(`${name} is not set`);
const logger = createLogger();
const browser = bindPort(
  browserPort,
  playwrightBrowser(variable("MARKER_SERVICE"), {
    testHosts: JSON.parse(variable("MARKER_HOSTS")) as string[],
    resolve: namesResolver(JSON.parse(variable("MARKER_NAMES")) as Record<string, string[]>),
  }),
  { adapter: "playwright" },
);
const failures: unknown[] = [];
let rendered = 0;
for (const url of JSON.parse(variable("MARKER_URLS")) as string[]) {
  await withSpan("browser.render", { provider: "playwright" }, () =>
    browser.renderPage({ url }),
  ).then(
    () => {
      rendered += 1;
    },
    (error: unknown) => {
      failures.push(error);
      logger.error({ err: error }, "page render failed");
    },
  );
}
await telemetry.shutdown();
const printed = inspect(failures, { depth: Number.POSITIVE_INFINITY, showHidden: true });
process.stdout.write(`${JSON.stringify({ failures: failures.length, rendered, printed })}\n`);

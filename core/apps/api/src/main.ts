// The api process (README "Start"): .env.local, then telemetry, then the host, imported only once the
// instrumentations' hook is in place, so that NestJS, pg and pino load patched. start() logs a failure
// with its code, a failed migration with its name; the process then exits 1 and never listens.
import { loadEnvLocal } from "./env-file.ts";

loadEnvLocal();
const { startTelemetry } = await import("@whytide/platform/telemetry");
const telemetry = startTelemetry({ serviceName: "api" });
const { start } = await import("./start.ts");

try {
  const api = await start();
  const stop = () => void api.close().finally(() => telemetry.shutdown());
  process.once("SIGTERM", stop).once("SIGINT", stop);
} catch {
  await telemetry.shutdown().catch(() => undefined);
  process.exit(1);
}

// The worker process (README "Start"): .env.local, then telemetry, then the host, imported only once
// the instrumentations' hook is in place. SIGTERM and SIGINT stop it; a failed start or a failed
// worker exits 1.
import { loadEnvLocal } from "./env-file.ts";

loadEnvLocal();
const { startTelemetry } = await import("@whytide/platform/telemetry");
const telemetry = startTelemetry({ serviceName: "worker" });
const { start } = await import("./start.ts");

try {
  const worker = await start();
  const stop = (code = 0) => {
    process.exitCode = code;
    void worker.close().finally(() => telemetry.shutdown());
  };
  process.once("SIGTERM", () => stop()).once("SIGINT", () => stop());
  worker.done.catch(() => stop(1));
} catch {
  await telemetry.shutdown().catch(() => undefined);
  process.exit(1);
}

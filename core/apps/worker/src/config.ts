// The worker's block of deploy/.env.example (README "Configuration"): the Temporal server and
// namespace, which `pnpm env:create` fills per worktree, the port of GET /health, whether the
// modules' schedules run, and the alerts' repeat window (README "Alerts").
import { AppError, defineConfig } from "@whytide/platform";
import { z } from "zod";
import { ALERT_REPEAT } from "./constants.ts";
import { workerErrors } from "./errors.ts";

export const workerConfig = defineConfig("apps/worker", {
  TEMPORAL_ADDRESS: z.string().min(1).default("127.0.0.1:7233"),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  WORKER_SCHEDULES: z.enum(["on", "off"]).default("on"),
  /** An alert whose key was queued within so many minutes is counted, not sent; 1 or more, no maximum. */
  ALERTS_REPEAT_MINUTES: z.coerce.number().int().positive().default(ALERT_REPEAT.default),
});

/** TEMPORAL_ADDRESS for smoke and history:record, which reach the stack on this machine only. */
export function localTemporalAddress(address: string = workerConfig.TEMPORAL_ADDRESS): string {
  const host = address.slice(0, address.lastIndexOf(":")).replace(/^\[(.*)\]$/, "$1");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    const details = { variable: "TEMPORAL_ADDRESS" };
    throw new AppError(workerErrors.temporal_address_not_local, { details });
  }
  return address;
}

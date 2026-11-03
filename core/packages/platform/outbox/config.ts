// The outbox's variables in the packages/platform block of deploy/.env.example: how many deliveries a
// row gets before it is dead-lettered, and how long the worker host waits between two looks at the
// table when the last one found nothing (alpha-p2-050 reads the second).
import { z } from "zod";
import { defineConfig } from "../config/define.ts";

export const outboxConfig = defineConfig("packages/platform", {
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  OUTBOX_POLL_MS: z.coerce.number().int().min(1).default(1_000),
});

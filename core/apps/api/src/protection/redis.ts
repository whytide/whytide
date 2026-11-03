// Redis for the request protections (docs/security.md): one client per app, which start() connects
// to REDIS_URL, holding nothing durable (docs/rules/coding.md §5), the rate limits' windows only. It
// never queues a command while offline and gives each one COMMAND_TIMEOUT_MS, so a rate limit that
// cannot ask it lets the request through at once; it reconnects by itself. GET /health reports it as
// `redis`, `ok` or `failing`, and neither the answer nor the log line carries its URL.
import { setTimeout as sleep } from "node:timers/promises";
import { createClient, type RedisClientType } from "@redis/client";
import type { Logger } from "@whytide/platform";
import { registerHealthCheck } from "../health.ts";
import { protectionConfig } from "./config.ts";

export type RedisClient = RedisClientType;

const COMMAND_TIMEOUT_MS = 500;
/** How long start() waits for the first connection; the api starts either way. */
const CONNECT_WAIT_MS = 2000;

/** A client of REDIS_URL, connected unless Redis did not answer within CONNECT_WAIT_MS. */
export async function connectRedis(log: Logger): Promise<RedisClient> {
  const client: RedisClient = createClient({
    url: protectionConfig.REDIS_URL,
    disableOfflineQueue: true,
    commandOptions: { timeout: COMMAND_TIMEOUT_MS },
    socket: {
      connectTimeout: CONNECT_WAIT_MS,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5000),
    },
  });
  // One line per outage: the client reports every failed reconnection.
  let reachable = true;
  client.on("error", (error: unknown) => {
    if (reachable) log.warn({ err: error }, "api: redis unreachable");
    reachable = false;
  });
  client.on("ready", () => {
    reachable = true;
  });
  const connected = client.connect().then(
    () => undefined,
    () => undefined,
  );
  await Promise.race([connected, sleep(CONNECT_WAIT_MS, undefined, { ref: false })]);
  return client;
}

/** Ends the client at once; the app has stopped taking requests. */
export function closeRedis(client: RedisClient): void {
  if (client.isOpen) client.destroy();
}

registerHealthCheck(
  "redis",
  ({ redis }) =>
    async () => {
      await redis.ping();
    },
  import.meta.url,
);

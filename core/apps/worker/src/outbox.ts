// The outbox delivery (README "Outbox"; platform README "Events and the outbox"): one loop per
// process calls deliverPending, again at once while a pass claims rows, else after OUTBOX_POLL_MS.
// Several workers are safe: the store claims rows under FOR UPDATE SKIP LOCKED. A subscriber runs
// in a tenant run for the event's workspace as service:worker. No LISTEN/NOTIFY in alpha: an event
// waits one poll interval at most. recordStats() sets the outbox's gauges, dead rows and lag.
import { createOutboxStore, type PrismaClient, type TenantClient, withTenant } from "@whytide/db";
import {
  deliverPending,
  type Logger,
  outboxConfig,
  type RunInTenant,
  recordOutboxStats,
  servicePrincipal,
} from "@whytide/platform";

export type OutboxLoop = {
  lastPollAt(): Date | undefined;
  recordStats(): Promise<void>;
  stop(): Promise<void>;
};

export function startOutboxLoop(client: PrismaClient, log: Logger): OutboxLoop {
  const principal = servicePrincipal("worker");
  const store = createOutboxStore(client);
  const runInTenant: RunInTenant<TenantClient> = (workspaceId, fn) =>
    withTenant({ workspaceId, principal }, fn, { client });
  let stopped = false;
  let last: Date | undefined;
  let wake = () => {};
  const loop = (async () => {
    while (!stopped) {
      let claimed = 0;
      try {
        ({ claimed } = await deliverPending({ store, runInTenant, log }));
      } catch (error) {
        log.error({ err: error }, "worker: an outbox pass failed");
      }
      last = new Date();
      if (claimed > 0 || stopped) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, outboxConfig.OUTBOX_POLL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();
  return {
    lastPollAt: () => last,
    async recordStats() {
      await recordOutboxStats(store).catch((error: unknown) => {
        log.warn({ err: error }, "worker: the outbox gauges failed");
      });
    },
    async stop() {
      stopped = true;
      wake();
      await loop;
    },
  };
}

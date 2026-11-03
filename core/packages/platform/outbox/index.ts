// The delivery runtime of the outbox (architecture §4.3 rule 4, §7.6; coding §9). The worker host
// calls deliverPending() in a loop: each call claims due rows under FOR UPDATE SKIP LOCKED through the
// store, runs every subscriber of each row in a tenant transaction for the row's workspace, and marks
// the row delivered. A throw schedules a retry with backoff and jitter; after OUTBOX_MAX_ATTEMPTS the
// row is dead-lettered with a log line and a counter, until replayDeadLetter() puts it back;
// recordOutboxStats() sets the gauges of dead rows and lag, which the worker calls on a timer. The row
// lock holds while the handlers run, so two deliverers never run one row at once, and a pass starts no
// row past half of the claim's timeout, so the claim does not outlive its transaction. A crash between
// a handler's commit and the mark redelivers the row, which is why consumers dedupe by event id.
import { AppError, defineErrors, isAppError } from "../errors/index.ts";
import { type EventContext, parseEventPayload, subscribersOf } from "../events/index.ts";
import { createLogger, type Logger, withLogContext } from "../logging/index.ts";
import { withSpan } from "../telemetry/index.ts";
import { type BackoffOptions, backoffMs } from "./backoff.ts";
import { outboxConfig } from "./config.ts";
import { outboxMetrics } from "./metrics.ts";
import type {
  OutboxMarks,
  OutboxRef,
  OutboxRow,
  OutboxStats,
  OutboxStore,
  RunInTenant,
} from "./store.ts";

export type DeliverPendingOptions<Tx> = {
  readonly store: OutboxStore;
  readonly runInTenant: RunInTenant<Tx>;
  /** Rows per pass; 100. */
  readonly limit?: number;
  /** Deliveries a row gets before it is dead-lettered; OUTBOX_MAX_ATTEMPTS. */
  readonly maxAttempts?: number;
  /** The clock; a test's. */
  readonly now?: () => Date;
  /** The schedule of transient failures; deterministic ones wait sixty times longer. */
  readonly backoff?: BackoffOptions;
  readonly log?: Logger;
  /** Time a pass may spend starting rows; half the store's claim timeout. The rest stay pending. */
  readonly budgetMs?: number;
};
export type OutboxDeliveryReport = {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly dead: number;
  /** Claimed rows the pass had no time for: still pending, taken by a later pass. */
  readonly deferred: number;
};
type Settings<Tx> = {
  readonly store: OutboxStore;
  readonly runInTenant: RunInTenant<Tx>;
  readonly limit: number;
  readonly maxAttempts: number;
  readonly now: () => Date;
  readonly backoff: BackoffOptions | undefined;
  readonly log: Logger;
  readonly budgetMs: number;
};
type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

const errors = defineErrors({ outbox_entry_not_found: {} });
/** Failures that repeat until a deploy catches up: they wait on the slow schedule, not the fast one. */
const DETERMINISTIC = new Set(["unknown_event", "invalid_event_payload"]);
const SLOW = 60;
let sharedLog: Logger | undefined;

/** Delivers the due rows once; the worker host loops, sleeping OUTBOX_POLL_MS when nothing was claimed. */
export async function deliverPending<Tx>(
  options: DeliverPendingOptions<Tx>,
): Promise<OutboxDeliveryReport> {
  const settings: Settings<Tx> = {
    store: options.store,
    runInTenant: options.runInTenant,
    limit: options.limit ?? 100,
    maxAttempts: options.maxAttempts ?? outboxConfig.OUTBOX_MAX_ATTEMPTS,
    now: options.now ?? (() => new Date()),
    backoff: options.backoff,
    log: options.log ?? (sharedLog ??= createLogger()),
    budgetMs: options.budgetMs ?? options.store.claimTimeoutMs / 2,
  };
  const report = { claimed: 0, delivered: 0, retried: 0, dead: 0, deferred: 0 };
  await settings.store.claim(settings.limit, settings.now(), async (rows, marks) => {
    report.claimed = rows.length;
    const started = settings.now().getTime();
    for (const [index, row] of rows.entries()) {
      if (settings.now().getTime() - started >= settings.budgetMs) {
        report.deferred = rows.length - index;
        break;
      }
      const outcome = await withLogContext({ workspace_id: row.workspaceId }, () =>
        deliverRow(row, marks, settings),
      );
      report[outcome] += 1;
    }
  });
  if (report.deferred) {
    settings.log.warn(
      { deferred_count: report.deferred, budget_ms: settings.budgetMs },
      "outbox: the pass ran out of time, rows left pending",
    );
  }
  return report;
}

/** Puts a dead row back in the queue for the next deliverPending(); `outbox_entry_not_found` when the workspace has no dead row with that id. */
export async function replayDeadLetter(
  store: OutboxStore,
  ref: OutboxRef,
  now = new Date(),
): Promise<void> {
  if (!(await store.replay(ref, now))) {
    throw new AppError(errors.outbox_entry_not_found, {
      details: { event_id: ref.id, workspace_id: ref.workspaceId },
    });
  }
}

/** Sets the gauges `outbox.dead_rows` and `outbox.lag` (seconds the oldest due row waited, or 0). */
export async function recordOutboxStats(
  store: OutboxStore,
  now = new Date(),
): Promise<OutboxStats> {
  const stats = await store.stats(now);
  const waited = stats.oldestDueAt ? now.getTime() - stats.oldestDueAt.getTime() : 0;
  outboxMetrics["outbox.dead_rows"].record(stats.dead, {});
  outboxMetrics["outbox.lag"].record(Math.max(0, waited) / 1000, {});
  return stats;
}

/** One row: the handlers, then the mark that fits what happened. */
async function deliverRow<Tx>(
  row: OutboxRow,
  marks: OutboxMarks,
  settings: Settings<Tx>,
): Promise<"delivered" | "retried" | "dead"> {
  const attempts = row.attempts + 1;
  const outcome = await runHandlers(row, attempts, settings);
  if (outcome.ok) {
    await marks.delivered(row, { attempts, deliveredAt: settings.now() });
    return "delivered";
  }
  const lastError = errorCode(outcome.error);
  const fields = { event: row.eventName, event_id: row.id, attempt: attempts, err: outcome.error };
  if (attempts >= settings.maxAttempts) {
    await marks.dead(row, { attempts, deadAt: settings.now(), lastError });
    settings.log.error(fields, "outbox: dead-lettered after the last attempt");
    outboxMetrics["outbox.dead_letters"].add(1, { event: row.eventName });
    return "dead";
  }
  const schedule = DETERMINISTIC.has(lastError) ? slow(settings.backoff) : settings.backoff;
  const nextAttemptAt = new Date(settings.now().getTime() + backoffMs(attempts, schedule));
  await marks.failed(row, { attempts, nextAttemptAt, lastError });
  settings.log.warn(
    { ...fields, next_attempt_at: nextAttemptAt.toISOString() },
    "outbox: delivery failed, retry scheduled",
  );
  return "retried";
}

/** Every subscriber of the row's event, each in its own tenant transaction, inside one span. */
async function runHandlers<Tx>(
  row: OutboxRow,
  attempt: number,
  { runInTenant, log }: Settings<Tx>,
): Promise<Outcome> {
  const attributes = {
    event: row.eventName,
    event_id: row.id,
    workspace_id: row.workspaceId,
    attempt,
  };
  try {
    await withSpan("outbox.deliver", attributes, async () => {
      const payload = parseEventPayload(row.eventName, row.payload);
      const handlers = subscribersOf(row.eventName);
      if (handlers.length === 0) {
        log.debug(
          { event: row.eventName, event_id: row.id },
          "outbox: no subscriber, marked delivered",
        );
        outboxMetrics["outbox.unhandled"].add(1, { event: row.eventName });
      }
      for (const handler of handlers) {
        await runInTenant(row.workspaceId, async (tx) => {
          const context: EventContext<Tx> = {
            id: row.id,
            name: row.eventName,
            workspaceId: row.workspaceId,
            createdAt: row.createdAt,
            attempt,
            tx,
          };
          await handler(payload, context);
        });
      }
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** What last_error records: the AppError code, else the error's class name; never a message. */
function errorCode(error: unknown): string {
  if (isAppError(error)) return error.code;
  return error instanceof Error ? error.name || "Error" : "unknown";
}

/** The slow schedule: the same curve from a base sixty times longer, half a minute doubling to the cap. */
function slow(options: BackoffOptions = {}): BackoffOptions {
  return { ...options, baseMs: (options.baseMs ?? 1_000) * SLOW };
}

export { type BackoffOptions, backoffMs } from "./backoff.ts";
export { outboxConfig } from "./config.ts";
export { outboxMetrics } from "./metrics.ts";
export type {
  NewOutboxRow,
  OutboxMarks,
  OutboxRef,
  OutboxRow,
  OutboxStats,
  OutboxStore,
  OutboxWriter,
  RunInTenant,
} from "./store.ts";

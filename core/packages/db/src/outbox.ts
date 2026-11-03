// The outbox store (core/packages/platform/README.md "Events and the outbox"): the platform's
// OutboxStore and OutboxWriter interfaces implemented with the Prisma client on the `outbox` table of
// prisma/schema/platform.prisma. The claim is the one query Prisma cannot say, FOR UPDATE SKIP LOCKED
// inside an interactive transaction, the row locks held while the handlers run; the marks and the
// replay are the model's own updates, always with workspace_id in the where (docs/rules/security.md §3).
// The stats, for the worker's gauges, count across workspaces as the claim reads: numbers, no row.
import type {
  NewOutboxRow,
  OutboxMarks,
  OutboxRow,
  OutboxStore,
  OutboxWriter,
} from "@whytide/platform";
import type { Prisma, PrismaClient } from "../generated/client.ts";

export type OutboxStoreOptions = {
  /** How long a claim's transaction may run, handlers included; 60 seconds. Prisma's own default is 5. */
  readonly claimTimeoutMs?: number;
};

/** A row as the raw claim returns it: the table's columns. */
type Raw = {
  id: string;
  workspace_id: string;
  event_name: string;
  payload: unknown;
  created_at: Date;
  delivered_at: Date | null;
  attempts: number;
  next_attempt_at: Date;
  dead_at: Date | null;
  last_error: string | null;
};

/**
 * What publish() takes: a Prisma transaction client bound to the workspace it works for, until the
 * tenant client of alpha-p1-045 carries both itself.
 */
export function outboxWriter(tx: Prisma.TransactionClient, workspaceId: string): OutboxWriter {
  return {
    workspaceId,
    async insertOutbox(row: NewOutboxRow) {
      await tx.outboxEntry.create({
        data: {
          id: row.id,
          workspaceId: row.workspaceId,
          eventName: row.eventName,
          payload: row.payload as Prisma.InputJsonValue,
          createdAt: row.createdAt,
          nextAttemptAt: row.nextAttemptAt,
        },
      });
    },
  };
}

/** The store deliverPending() and replayDeadLetter() run on, for the worker host, as `app`. */
export function createOutboxStore(
  prisma: PrismaClient,
  options: OutboxStoreOptions = {},
): OutboxStore {
  const timeout = options.claimTimeoutMs ?? 60_000;
  return {
    claimTimeoutMs: timeout,
    claim(limit, now, fn) {
      return prisma.$transaction(
        async (tx) => {
          const raw = await tx.$queryRaw<Raw[]>`
            SELECT id, workspace_id, event_name, payload, created_at, delivered_at, attempts,
                   next_attempt_at, dead_at, last_error
            FROM outbox
            WHERE delivered_at IS NULL AND dead_at IS NULL AND next_attempt_at <= ${now}
            ORDER BY created_at, id
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED`;
          await fn(raw.map(toRow), marks(tx));
        },
        { timeout, maxWait: 5_000 },
      );
    },
    async replay({ workspaceId, id }, now) {
      const { count } = await prisma.outboxEntry.updateMany({
        where: { id, workspaceId, deadAt: { not: null } },
        data: { deadAt: null, attempts: 0, nextAttemptAt: now },
      });
      return count === 1;
    },
    async stats(now) {
      // Both on the claim's index (delivered_at, dead_at, next_attempt_at): undelivered rows only.
      const [row] = await prisma.$queryRaw<{ dead: bigint; oldest: Date | null }[]>`
        SELECT count(*) FILTER (WHERE dead_at IS NOT NULL) AS dead,
               min(next_attempt_at) FILTER (WHERE dead_at IS NULL AND next_attempt_at <= ${now}) AS oldest
        FROM outbox
        WHERE delivered_at IS NULL`;
      return { dead: Number(row?.dead ?? 0), oldestDueAt: row?.oldest ?? null };
    },
  };
}

function marks(tx: Prisma.TransactionClient): OutboxMarks {
  const update = async (row: OutboxRow, data: Prisma.OutboxEntryUpdateManyMutationInput) => {
    await tx.outboxEntry.updateMany({ where: { id: row.id, workspaceId: row.workspaceId }, data });
  };
  return {
    delivered: (row, { attempts, deliveredAt }) => update(row, { attempts, deliveredAt }),
    failed: (row, { attempts, nextAttemptAt, lastError }) =>
      update(row, { attempts, nextAttemptAt, lastError }),
    dead: (row, { attempts, deadAt, lastError }) => update(row, { attempts, deadAt, lastError }),
  };
}

function toRow(raw: Raw): OutboxRow {
  return {
    id: raw.id,
    workspaceId: raw.workspace_id,
    eventName: raw.event_name,
    payload: raw.payload as OutboxRow["payload"],
    createdAt: raw.created_at,
    deliveredAt: raw.delivered_at,
    attempts: raw.attempts,
    nextAttemptAt: raw.next_attempt_at,
    deadAt: raw.dead_at,
    lastError: raw.last_error,
  };
}

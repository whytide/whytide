// What the outbox runtime needs from the database, as small interfaces the platform declares and
// core/packages/db implements with the Prisma client (the platform never imports @whytide/db): the
// insert inside the caller's tenant transaction, the claim of due rows under FOR UPDATE SKIP LOCKED
// with the marks inside that same transaction, and the replay of a dead row. A host wires them in.
import type { EventPayload } from "../events/index.ts";

/** A row of the `outbox` table (core/packages/db, prisma/schema/platform.prisma). */
export type OutboxRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventName: string;
  /** Ids only: the event's registered schema admits nothing else. */
  readonly payload: EventPayload;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
  /** Deliveries tried so far, the successful one included. */
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly deadAt: Date | null;
  /** The error code of the last failed delivery, never a message. */
  readonly lastError: string | null;
};
export type NewOutboxRow = Pick<
  OutboxRow,
  "id" | "workspaceId" | "eventName" | "payload" | "createdAt" | "nextAttemptAt"
>;
export type OutboxRef = { readonly workspaceId: string; readonly id: string };
/** The gauges' inputs, over every workspace: the dead rows, and the oldest due row's due time. */
export type OutboxStats = { readonly dead: number; readonly oldestDueAt: Date | null };

/** The caller's tenant transaction as publish() sees it: its workspace and an insert inside it. */
export interface OutboxWriter {
  readonly workspaceId: string;
  insertOutbox(row: NewOutboxRow): Promise<void>;
}

/** The updates on a claimed row, inside the claim's transaction, always by id and workspace. */
export interface OutboxMarks {
  delivered(
    row: OutboxRow,
    at: { readonly attempts: number; readonly deliveredAt: Date },
  ): Promise<void>;
  failed(
    row: OutboxRow,
    next: { readonly attempts: number; readonly nextAttemptAt: Date; readonly lastError: string },
  ): Promise<void>;
  dead(
    row: OutboxRow,
    at: { readonly attempts: number; readonly deadAt: Date; readonly lastError: string },
  ): Promise<void>;
}

export interface OutboxStore {
  /** How long one claim transaction may run; the runtime starts no row past half of it. */
  readonly claimTimeoutMs: number;
  /**
   * In one transaction: locks up to `limit` due rows (not delivered, not dead, next_attempt_at at or
   * before `now`), oldest first, with FOR UPDATE SKIP LOCKED, so that a second deliverer takes other
   * rows; runs `fn` with them and the marks; commits when it returns, rolls back when it throws.
   */
  claim(
    limit: number,
    now: Date,
    fn: (rows: readonly OutboxRow[], marks: OutboxMarks) => Promise<void>,
  ): Promise<void>;
  /** Puts a dead row of the workspace back in the queue: dead_at cleared, attempts 0, due at `now`. False when there is no such dead row. */
  replay(ref: OutboxRef, now: Date): Promise<boolean>;
  /** Counts only, for the metrics: the dead rows and the earliest next_attempt_at of a due row. */
  stats(now: Date): Promise<OutboxStats>;
}

/**
 * Runs `fn` in a tenant transaction for the workspace (SET LOCAL app.workspace_id; commit on return,
 * roll back on a throw), what the worker host builds from alpha-p1-045's withTenant.
 */
export type RunInTenant<Tx> = <T>(workspaceId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;

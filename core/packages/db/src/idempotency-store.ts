// The platform's idempotency store on a Prisma transaction (core/packages/platform/idempotency):
// withIdempotency takes the IdempotencyStore interface, this adapts the client to it. The insert is
// INSERT … ON CONFLICT DO NOTHING, so two requests with one key at once never both store a response,
// and the transaction of the one that lost stays usable until the platform rolls it back.
import type { IdempotencyBody, IdempotencyStore } from "@whytide/platform";
import { Prisma } from "../generated/client.ts";

/** `withIdempotency(idempotencyStore(tx), …)`: idempotency_records through `tx`, a transaction or a client. */
export function idempotencyStore(tx: Prisma.TransactionClient): IdempotencyStore {
  return {
    async findIdempotencyRecord(workspaceId, key) {
      const row = await tx.idempotencyRecord.findUnique({
        where: { workspaceId_key: { workspaceId, key } },
      });
      if (!row) return null;
      return {
        id: row.id,
        workspace_id: row.workspaceId,
        key: row.key,
        request_hash: row.requestHash,
        response_status: row.responseStatus,
        response_body: row.responseBody as IdempotencyBody,
        created_at: row.createdAt,
        expires_at: row.expiresAt,
      };
    },
    async insertIdempotencyRecord(record) {
      const { count } = await tx.idempotencyRecord.createMany({
        data: {
          id: record.id,
          workspaceId: record.workspace_id,
          key: record.key,
          requestHash: record.request_hash,
          responseStatus: record.response_status,
          responseBody:
            record.response_body === null
              ? Prisma.JsonNull
              : (record.response_body as Prisma.InputJsonValue),
          createdAt: record.created_at,
          expiresAt: record.expires_at,
        },
        skipDuplicates: true,
      });
      return count === 1;
    },
    async deleteExpiredIdempotencyRecords(workspaceId, createdBefore) {
      // By created_at, a range on the (workspace_id, created_at) index: expires_at is created_at plus
      // the TTL, and an index on it alone would be one more to keep.
      const { count } = await tx.idempotencyRecord.deleteMany({
        where: { workspaceId, createdAt: { lt: createdBefore } },
      });
      return count;
    },
  };
}

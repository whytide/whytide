// Idempotency records (security §5, RB-1.3.7): a write that spends credits or calls a provider takes
// an idempotency key, and a POST with one is answered once. withIdempotency runs inside the caller's
// tenant transaction through a store this package declares and core/packages/db implements with
// Prisma (idempotencyStore); the HTTP header and decorator that call it are alpha-p2-030's. A record
// lives 24 hours and is swept lazily, inside the call, in place of a job; its body is the endpoint's
// answer and may carry person data until then, so the deletion script covers the table.
import { z } from "zod";
import { AppError, defineErrors } from "../errors/index.ts";
import { newId, platformIds } from "../ids/index.ts";

/** The JSON body an endpoint answered with: what is stored and replayed. */
export type IdempotencyBody =
  | string
  | number
  | boolean
  | null
  | IdempotencyBody[]
  | { [key: string]: IdempotencyBody };

/** How long a key is remembered: 24 hours from the first response. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type IdempotencyRecord = {
  readonly id: string;
  readonly workspace_id: string;
  readonly key: string;
  readonly request_hash: string;
  readonly response_status: number;
  readonly response_body: IdempotencyBody;
  readonly created_at: Date;
  readonly expires_at: Date;
};

/** What withIdempotency needs from the caller's transaction; core/packages/db implements it. */
export interface IdempotencyStore {
  findIdempotencyRecord(workspaceId: string, key: string): Promise<IdempotencyRecord | null>;
  /** False when a record with the key exists already: another request stored it first. */
  insertIdempotencyRecord(record: IdempotencyRecord): Promise<boolean>;
  /**
   * Deletes the workspace's records created before `createdBefore`, now minus the TTL: a range on the
   * (workspace_id, created_at) index over exactly the expired rows; returns how many.
   */
  deleteExpiredIdempotencyRecords(workspaceId: string, createdBefore: Date): Promise<number>;
}

export type IdempotentRequest = {
  readonly workspaceId: string;
  /** The client's key, as sent, up to 255 characters. */
  readonly key: string;
  /** A hash of the request the key came with (method, path, body), computed by the caller. */
  readonly requestHash: string;
};
export type IdempotentResponse = { readonly status: number; readonly body: IdempotencyBody };
export type IdempotentResult = IdempotentResponse & {
  /** True when the response is the stored one and `fn` did not run. */
  readonly replayed: boolean;
};

const idempotentRequest = z.object({
  workspaceId: z.string().min(1),
  key: z.string().min(1).max(255),
  requestHash: z.string().min(1).max(255),
});

const errors = defineErrors({
  invalid_idempotency_key: {},
  idempotency_key_reused: { status: 422 },
  idempotency_key_conflict: {},
});

/**
 * Answers a request once per key and workspace: the stored response for a key seen with the same
 * hash (`replayed`), `idempotency_key_reused` (422) for one seen with another hash; otherwise runs
 * `fn`, stores its status and body for 24 hours and returns them. Records older than the TTL are
 * forgotten and swept here, by created_at. Two requests with one key at the same time: the first to
 * store wins, the other is `idempotency_key_conflict` (409) and its transaction rolls back, so its
 * retry gets the stored response.
 */
export async function withIdempotency(
  tx: IdempotencyStore,
  request: IdempotentRequest,
  fn: () => Promise<IdempotentResponse>,
): Promise<IdempotentResult> {
  const parsed = idempotentRequest.safeParse(request);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new AppError(errors.invalid_idempotency_key, { details: { fields } });
  }
  const { workspaceId, key, requestHash } = parsed.data;
  const now = new Date();
  await tx.deleteExpiredIdempotencyRecords(
    workspaceId,
    new Date(now.getTime() - IDEMPOTENCY_TTL_MS),
  );
  const seen = await tx.findIdempotencyRecord(workspaceId, key);
  if (seen && seen.expires_at > now) {
    if (seen.request_hash !== requestHash) {
      throw new AppError(errors.idempotency_key_reused, { details: { workspace_id: workspaceId } });
    }
    return { status: seen.response_status, body: seen.response_body, replayed: true };
  }
  const response = await fn();
  const stored = await tx.insertIdempotencyRecord({
    id: newId(platformIds.idempotency_record),
    workspace_id: workspaceId,
    key,
    request_hash: requestHash,
    response_status: response.status,
    response_body: response.body,
    created_at: now,
    expires_at: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
  });
  if (!stored) {
    throw new AppError(errors.idempotency_key_conflict, { details: { workspace_id: workspaceId } });
  }
  return { status: response.status, body: response.body, replayed: false };
}

// The shapes of credits (README "Public interface"): what the credits client takes, and the query and
// answers of the balance and usage routes, from which the api host writes the OpenAPI document.
// Amounts are decimal strings, the way Postgres numeric holds them, never a float.
import { z } from "zod";

export const amount = z.string().regex(/^\d+(?:\.\d+)?$/);
const quantity = z.number().nonnegative().max(1_000_000_000);

export const reserveInput = z.strictObject({
  workspaceId: z.string().min(1).max(64),
  action: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
  quantity: quantity.positive(),
  idempotencyKey: z.string().min(1).max(200),
  /** An id (`lead_…`): letters, digits and `_` only, so never an email or a name. */
  subjectRef: z
    .string()
    .regex(/^[a-z][a-z0-9_]*_[0-9A-Za-z]+$/)
    .max(120),
  lease: z.enum(["sync", "async"]),
});

export const settleInput = z.strictObject({
  usageId: z.string().min(1).max(64),
  actualQuantity: quantity.optional(),
});

export const balanceResponse = z.strictObject({
  available: amount,
  granted: amount,
  reserved: amount,
  committed: amount,
  /** The end of the organization's current period; null before its first grant. */
  periodEnd: z.iso.datetime().nullable(),
});
export type BalanceResponse = z.infer<typeof balanceResponse>;

export const usageQuery = z.strictObject({
  /** Rows created at or after it. */
  from: z.iso.datetime({ offset: true }).optional(),
  /** Rows created before it. */
  to: z.iso.datetime({ offset: true }).optional(),
  /** The `nextCursor` of the page before. */
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type UsageQuery = z.infer<typeof usageQuery>;

export const usageResponse = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.string(),
      action: z.string(),
      quantity: amount,
      credits: amount,
      status: z.enum(["reserved", "committed", "released", "expired"]),
      subjectRef: z.string(),
      createdAt: z.iso.datetime(),
      leaseExpiresAt: z.iso.datetime(),
      settledAt: z.iso.datetime().nullable(),
    }),
  ),
  /** The cursor of the next page; null on the last. */
  nextCursor: z.string().nullable(),
});
export type UsageResponse = z.infer<typeof usageResponse>;

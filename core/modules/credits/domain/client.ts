// The credits client (README "Reserving", docs/concepts.md, docs/flows.md), bound into the platform's
// `credits` at the api's and the worker's start. Every method runs in the caller's own tenant run, on
// its transaction: reserve takes the organization's advisory lock, expires the organization's
// reservations past their lease, checks the balance and inserts the usage, all in that transaction,
// so two reserves of one organization never pass the check together; commit and release take the
// same lock first (README "Decided here"). Sums stay Postgres numeric: Prisma's Decimal computes
// with 20 digits only. Each outcome counts in the metric credits.usage (metrics.ts).
import { type TenantClient, tenantClient } from "@whytide/db";
import {
  AppError,
  type CreditsClient,
  currentTenant,
  newId,
  tenantErrors,
} from "@whytide/platform";
import type { z } from "zod";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import { creditsMetrics } from "../metrics.ts";
import { reserveInput, settleInput } from "../schemas/credits.ts";
import { walletOf } from "./balance.ts";
import { leaseExpiresAt } from "./lease.ts";
import { currentPrice } from "./prices.ts";
import { organizationOf } from "./store.ts";

/** The input as the schema reads it, or credits_input_invalid naming the fields at fault. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map(({ path }) => path.join(".")))];
  throw new AppError(errors.credits_input_invalid, { details: { fields } });
}

/** The run's client, when the run is the workspace's; another workspace is tenant_mismatch. */
function runOf(workspaceId: string): TenantClient {
  if (currentTenant().workspaceId !== workspaceId) throw new AppError(tenantErrors.tenant_mismatch);
  return tenantClient;
}

type Outcome = "reserved" | "insufficient" | "committed" | "released" | "expired";
const counted = (outcome: Outcome, count = 1) => {
  if (count > 0) creditsMetrics["credits.usage"].add(count, { outcome });
};

const notOpen = (usageId: string) =>
  new AppError(errors.usage_not_open, { details: { usage_id: usageId } });

/**
 * The organization of the workspace, its lock taken and held to the run's end, before any row: a
 * run that settles, then reserves, never holds the balance row while it waits on a reserve that
 * waits on that row.
 */
async function lockWallet(tx: TenantClient, workspaceId: string): Promise<string | null> {
  const organizationId = await organizationOf(tx, workspaceId);
  if (organizationId === null) return null;
  const wallet = `credits.wallet:${organizationId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${wallet}::text, 0))`;
  return organizationId;
}

/** The client on a clock: tests move it past a lease. */
export function createCreditsClient(now: () => Date = () => new Date()): CreditsClient {
  return {
    async reserve(input) {
      const valid = parse(reserveInput, input);
      const { workspaceId, action, quantity, idempotencyKey, subjectRef, lease } = valid;
      const tx = runOf(workspaceId);
      const organizationId = await lockWallet(tx, workspaceId);
      if (organizationId === null) {
        counted("insufficient");
        throw new AppError(errors.insufficient_credits);
      }
      const repeat = await tx.creditUsage.findFirst({ where: { idempotencyKey } });
      if (repeat) return { usageId: repeat.id, credits: repeat.credits.toFixed() };
      const price = await currentPrice(tx, action);
      const at = now();
      const expired = await tx.$executeRaw`UPDATE credit_usage SET status = 'expired',
          settled_at = ${at}::timestamptz
        WHERE organization_id = ${organizationId} AND status = 'reserved'
          AND lease_expires_at <= ${at}::timestamptz`;
      counted("expired", expired);
      const [check] = await tx.$queryRaw<{ credits: string; enough: boolean }[]>`
        SELECT trim_scale(c.credits)::text AS credits, c.credits <= COALESCE((
          SELECT granted - reserved - committed FROM credit_balances
          WHERE organization_id = ${organizationId}), 0) AS enough
        FROM (SELECT (${price.credits}::numeric * ${String(quantity)}::numeric)::numeric(65, 30)
          AS credits) c`;
      if (!check?.enough) {
        counted("insufficient");
        throw new AppError(errors.insufficient_credits, { details: { action } });
      }
      const { credits } = check;
      const { id } = await tx.creditUsage.create({
        data: {
          id: newId(ids.credit_usage),
          organizationId,
          workspaceId,
          action,
          quantity: String(quantity),
          credits,
          idempotencyKey,
          subjectRef,
          leaseExpiresAt: leaseExpiresAt(lease, at),
          createdAt: at,
        },
        select: { id: true },
      });
      counted("reserved");
      return { usageId: id, credits };
    },

    async commit(usageId, actualQuantity) {
      const valid = parse(settleInput, { usageId, actualQuantity });
      const actual = valid.actualQuantity === undefined ? null : String(valid.actualQuantity);
      const { workspaceId } = currentTenant();
      await lockWallet(tenantClient, workspaceId);
      const at = now();
      // The credits of the actual quantity, pro rata of the reservation and never above it.
      const [row] = await tenantClient.$queryRaw<{ credits: string }[]>`
        UPDATE credit_usage SET status = 'committed', settled_at = ${at}::timestamptz,
          quantity = COALESCE(${actual}::numeric, quantity),
          credits = CASE WHEN ${actual}::numeric IS NULL THEN credits ELSE LEAST(credits,
            (credits * ${actual}::numeric / NULLIF(quantity, 0))::numeric(65, 30)) END
        WHERE id = ${valid.usageId} AND workspace_id = ${workspaceId} AND status = 'reserved'
          AND lease_expires_at > ${at}::timestamptz
        RETURNING trim_scale(credits)::text AS credits`;
      if (row) {
        counted("committed");
        return { usageId: valid.usageId, credits: row.credits };
      }
      const usage = await tenantClient.creditUsage.findUnique({ where: { id: valid.usageId } });
      if (usage?.status !== "committed") throw notOpen(valid.usageId);
      return { usageId: usage.id, credits: usage.credits.toFixed() };
    },

    async release(usageId) {
      const valid = parse(settleInput, { usageId });
      await lockWallet(tenantClient, currentTenant().workspaceId);
      const where = { id: valid.usageId, status: "reserved" as const };
      const data = { status: "released" as const, settledAt: now() };
      const { count } = await tenantClient.creditUsage.updateMany({ where, data });
      counted("released", count);
      if (count > 0) return;
      const usage = await tenantClient.creditUsage.findUnique({ where: { id: valid.usageId } });
      // Freed already, by a release or the sweep: the same outcome.
      if (usage?.status !== "released" && usage?.status !== "expired") throw notOpen(valid.usageId);
    },

    async balance(workspaceId) {
      return walletOf(runOf(workspaceId), workspaceId);
    },

    async priceOf(action) {
      return currentPrice(tenantClient, action);
    },
  };
}

/** The client the hosts bind at start. */
export const creditsClient = createCreditsClient();

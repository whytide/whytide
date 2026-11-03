// The wallet as a workspace sees it (README "Public interface"): one balance per organization, read
// outside a run (readBalance) or in the caller's run (walletOf, the client's and the route's).
import type { TenantClient } from "@whytide/db";
import type { CreditsBalance } from "@whytide/platform";
import { findWorkspace } from "@whytide/tenancy";
import { inGlobal, organizationOf } from "./store.ts";

/** The balance row, its numbers as decimal strings, the way Postgres numeric holds them. */
export type Balance = {
  readonly organizationId: string;
  readonly granted: string;
  readonly reserved: string;
  readonly committed: string;
  readonly updatedAt: Date;
};

/**
 * The balance of the organization the workspace belongs to, as tenancy says, never an organization a
 * caller names; null for an unknown workspace or an organization without a grant yet. Outside a
 * tenant run only: both reads go through withoutTenant.
 */
export async function readBalance(workspaceId: string): Promise<Balance | null> {
  const workspace = await findWorkspace(workspaceId);
  if (workspace === null) return null;
  const { organizationId } = workspace;
  const row = await inGlobal("balance", (db) =>
    db.creditBalance.findUnique({ where: { organizationId } }),
  );
  if (row === null) return null;
  const { granted, reserved, committed, updatedAt } = row;
  return {
    organizationId,
    granted: granted.toString(),
    reserved: reserved.toString(),
    committed: committed.toString(),
    updatedAt,
  };
}

/**
 * The wallet of the workspace's organization in the caller's run, zeros before its first grant: the
 * sums in Postgres numeric, as decimal strings, and the end of its subscription's period.
 */
export async function walletOf(tx: TenantClient, workspaceId: string): Promise<CreditsBalance> {
  const organizationId = await organizationOf(tx, workspaceId);
  const [row] = await tx.$queryRaw<CreditsBalance[]>`
    SELECT trim_scale(COALESCE(b.granted - b.reserved - b.committed, 0))::text AS available,
      trim_scale(COALESCE(b.granted, 0))::text AS granted,
      trim_scale(COALESCE(b.reserved, 0))::text AS reserved,
      trim_scale(COALESCE(b.committed, 0))::text AS committed, s.period_end AS "periodEnd"
    FROM (SELECT ${organizationId}::text AS id) o
      LEFT JOIN credit_balances b ON b.organization_id = o.id
      LEFT JOIN subscriptions s ON s.organization_id = o.id`;
  const zero = { available: "0", granted: "0", reserved: "0", committed: "0", periodEnd: null };
  return row ?? zero;
}

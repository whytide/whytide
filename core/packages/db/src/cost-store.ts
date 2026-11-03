// The platform's cost store on a Prisma transaction (core/packages/platform/cost): recordCost takes
// the CostStore interface, this adapts the client to it, so the platform never imports this package.
import type { CostStore } from "@whytide/platform";
import type { Prisma } from "../generated/client.ts";

/** `recordCost(costStore(tx), row)`: inserts into cost_events through `tx`, a transaction or a client. */
export function costStore(tx: Prisma.TransactionClient): CostStore {
  return {
    async insertCostEvent(row) {
      await tx.costEvent.create({
        data: {
          id: row.id,
          workspaceId: row.workspace_id,
          feature: row.feature,
          task: row.task,
          vendor: row.vendor,
          model: row.model,
          units: row.units,
          unitCost: row.unit_cost,
          credits: row.credits,
          priceListVersion: row.price_list_version,
          subjectRef: row.subject_ref,
          createdAt: row.created_at,
        },
      });
    },
  };
}

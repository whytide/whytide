// cancelItems (README.md "Public interface"; docs/flows.md "A cancel"): campaigns' call, in its own
// transaction, whenever it holds, cancels or skips a step that has an open item, so a press in "Up
// next" after that finds the item decided (approval_item_not_pending). Only a `pending` item is
// blocked; an approved, skipped or blocked one stays as it is.
import { tenantClient } from "@whytide/db";
import { z } from "zod";
import { id, parse } from "./store.ts";

/** Every pending item of the steps becomes `blocked`; the items blocked. approvals_input_invalid. */
export async function cancelItems(stepExecutionIds: readonly string[]): Promise<number> {
  const steps = [...new Set(parse(z.array(id), stepExecutionIds))];
  if (steps.length === 0) return 0;
  const where = { stepExecutionId: { in: steps }, status: "pending" as const };
  const { count } = await tenantClient.approvalItem.updateMany({
    where,
    data: { status: "blocked" },
  });
  return count;
}

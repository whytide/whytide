// The week's costs (README "The cost counter"; docs/concepts.md "Costs"), for GET …/credits/costs, in
// the caller's tenant run and for its workspace only: the credits committed by the usage created in
// the ISO week, by action; what the vendors cost, the unit_cost of the cost events created in it, by
// vendor; the leads its assessments qualified, qualification's count; and both per 100 of those
// leads, null when there are none. Postgres sums each group; the totals are exact (decimal.ts).
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, tenantErrors } from "@whytide/platform";
import { countQualified } from "@whytide/qualification";
import { errors } from "../../errors.ts";
import { share, sum } from "./decimal.ts";
import { type Week, weekRange } from "./week.ts";

export type WeeklyCosts = Week & {
  readonly credits: string;
  readonly money: string;
  readonly qualified: number;
  readonly byAction: { action: string; credits: string }[];
  readonly byVendor: { vendor: string; money: string }[];
  readonly costPer100Qualified: { credits: string; money: string } | null;
};

export async function weeklyCosts(input: {
  workspaceId: string;
  week: string;
}): Promise<WeeklyCosts> {
  if (currentTenant().workspaceId !== input.workspaceId) {
    throw new AppError(tenantErrors.tenant_mismatch);
  }
  const week = weekRange(input.week);
  if (week === null) {
    throw new AppError(errors.credits_input_invalid, { details: { fields: ["week"] } });
  }
  const createdAt = { gte: week.start, lt: week.end };
  const actions = await tenantClient.creditUsage.groupBy({
    by: ["action"],
    where: { status: "committed", createdAt },
    _sum: { credits: true },
    orderBy: { action: "asc" },
  });
  const vendors = await tenantClient.costEvent.groupBy({
    by: ["vendor"],
    where: { createdAt },
    _sum: { unitCost: true },
    orderBy: { vendor: "asc" },
  });
  const byAction = actions.map(({ action, _sum }) => ({
    action,
    credits: _sum.credits?.toFixed() ?? "0",
  }));
  const byVendor = vendors.map(({ vendor, _sum }) => ({
    vendor,
    money: _sum.unitCost?.toFixed() ?? "0",
  }));
  const credits = sum(byAction.map((row) => row.credits));
  const money = sum(byVendor.map((row) => row.money));
  const qualified = await countQualified({ from: week.start, to: week.end });
  const costPer100Qualified =
    qualified === 0
      ? null
      : { credits: share(credits, 100, qualified), money: share(money, 100, qualified) };
  return { ...week, credits, money, qualified, byAction, byVendor, costPer100Qualified };
}

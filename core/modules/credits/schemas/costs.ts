// The shapes of the cost counter's routes (README "The cost counter"), from which the api host writes
// the OpenAPI document: the week's costs and a lead's. Amounts are decimal strings, never a float;
// money is the cost events' unit_cost, in the price list's currency (COST_PRICES_JSON).
import { z } from "zod";
import { amount } from "./credits.ts";

export const costsQuery = z.strictObject({
  /** An ISO week in UTC, `2026-W44`; the current week when absent. */
  week: z
    .string()
    .regex(/^\d{4}-W\d{2}$/)
    .optional(),
});
export type CostsQuery = z.infer<typeof costsQuery>;

export const costsResponse = z.strictObject({
  week: z.string(),
  /** The week's Monday, 00:00 UTC. */
  start: z.iso.datetime(),
  /** The next Monday, 00:00 UTC, excluded. */
  end: z.iso.datetime(),
  /** The credits committed by the usage created in the week. */
  credits: amount,
  /** What the vendors cost for the calls of the week. */
  money: amount,
  /** The leads the week's assessments qualified, each once. */
  qualified: z.number().int().nonnegative(),
  byAction: z.array(z.strictObject({ action: z.string(), credits: amount })),
  byVendor: z.array(z.strictObject({ vendor: z.string(), money: amount })),
  /** Credits and money per 100 qualified leads; null when the week qualified none. */
  costPer100Qualified: z.strictObject({ credits: amount, money: amount }).nullable(),
});
export type CostsResponse = z.infer<typeof costsResponse>;

export const leadCostParams = z.strictObject({ personId: z.string().min(1).max(64) });

export const leadCostResponse = z.strictObject({
  personId: z.string(),
  credits: amount,
  money: amount,
  /** By module: its assessments' credits and calls, its drafts' calls, its share of the reads. */
  byFeature: z.array(z.strictObject({ feature: z.string(), credits: amount, money: amount })),
});
export type LeadCostResponse = z.infer<typeof leadCostResponse>;

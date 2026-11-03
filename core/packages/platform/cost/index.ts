// Cost events (coding §9, architecture §16): the single record of what a provider or model call cost,
// with workspace, feature, task, vendor, model, units and the price list's version. recordCost writes
// one through the store the caller's transaction gives it: an interface this package declares and
// core/packages/db implements with Prisma (costStore), so the platform never imports the client.
import { z } from "zod";
import { AppError, defineErrors } from "../errors/index.ts";
import { newId, platformIds } from "../ids/index.ts";
import { costConfig } from "./config.ts";
import { type PriceTable, priceFor } from "./prices.ts";

export { costConfig } from "./config.ts";
export {
  NO_MODEL,
  type Priced,
  type PriceLookup,
  type PriceTable,
  priceFor,
  priceTable,
  priceTableJson,
} from "./prices.ts";

const name = z.string().min(1).max(200);
const costEventInput = z.object({
  workspace_id: name,
  feature: name,
  task: name.nullish(),
  vendor: name,
  model: name.nullish(),
  /** A unit kind the vendor bills (`input_tokens`, `pages`) to its count in the call. */
  units: z
    .record(name, z.number().nonnegative())
    .refine((units) => Object.keys(units).length > 0, "at least one unit kind"),
  /** What the workspace was charged, when the caller knows it. */
  credits: z.number().nonnegative().nullish(),
  /** A person id when the call was about one person: the cost counter per lead reads it. */
  subject_ref: name.nullish(),
});
export type CostEventInput = z.input<typeof costEventInput>;

/** The row as cost_events holds it; `unit_cost` is a decimal string, which numeric takes exactly. */
export type CostEventRow = {
  readonly id: string;
  readonly workspace_id: string;
  readonly feature: string;
  readonly task: string | null;
  readonly vendor: string;
  readonly model: string | null;
  readonly units: Readonly<Record<string, number>>;
  readonly unit_cost: string;
  readonly credits: number | null;
  readonly price_list_version: string;
  readonly subject_ref: string | null;
  readonly created_at: Date;
};

/** What recordCost needs from the caller's transaction; core/packages/db implements it. */
export interface CostStore {
  insertCostEvent(row: CostEventRow): Promise<void>;
}

export type RecordCostOptions = {
  /** Another table than COST_PRICES_JSON: a test's, or a host's that loads prices elsewhere. */
  readonly prices?: PriceTable;
};

const errors = defineErrors({ invalid_cost_event: {}, cost_prices_not_configured: {} });

/**
 * Writes one cost event inside `tx`, priced from the table: `unit_cost` is what the units cost at the
 * list's prices, `price_list_version` the list's version. A row without `workspace_id`, `feature`,
 * `vendor` or `units` is `invalid_cost_event` and nothing is written. Returns the row, with its id.
 */
export async function recordCost(
  tx: CostStore,
  input: CostEventInput,
  options: RecordCostOptions = {},
): Promise<CostEventRow> {
  const parsed = costEventInput.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new AppError(errors.invalid_cost_event, { details: { fields } });
  }
  const table = options.prices ?? costConfig.COST_PRICES_JSON;
  if (!table) {
    throw new AppError(errors.cost_prices_not_configured, {
      details: { variable: "COST_PRICES_JSON" },
    });
  }
  const { workspace_id, feature, task, vendor, model, units, credits, subject_ref } = parsed.data;
  const row: CostEventRow = {
    id: newId(platformIds.cost_event),
    workspace_id,
    feature,
    task: task ?? null,
    vendor,
    model: model ?? null,
    units,
    ...priceFor(table, { vendor, model: model ?? null, units }),
    credits: credits ?? null,
    subject_ref: subject_ref ?? null,
    created_at: new Date(),
  };
  await tx.insertCostEvent(row);
  return row;
}

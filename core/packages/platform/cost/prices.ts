// The price table (coding §9, architecture §16): per vendor and model, the price of one unit of each
// kind the vendor bills (a token, a page, a call) and the list's version, so a cost event says what
// a call cost at which prices. It comes from COST_PRICES_JSON (config.ts); the lookup is pure.
import { z } from "zod";
import { AppError, defineErrors } from "../errors/index.ts";

/** The model key of a vendor's prices that depend on no model: a page fetched, an API call. */
export const NO_MODEL = "*";

const name = z.string().min(1).max(200);
const unitPrices = z.record(name, z.number().nonnegative());

/**
 * `{ version, prices: { [vendor]: { [model or "*"]: { [unit kind]: price per unit } } } }`. Strict at
 * the top, so a misspelled key fails at start as config_invalid, not as cost_price_missing per call.
 */
export const priceTable = z.strictObject({
  version: name,
  prices: z.record(name, z.record(name, unitPrices)),
});
export type PriceTable = z.infer<typeof priceTable>;

/** The table as one JSON string, what COST_PRICES_JSON holds. */
export const priceTableJson = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "valid JSON" });
      return z.NEVER;
    }
  })
  .pipe(priceTable);

export type PriceLookup = {
  readonly vendor: string;
  /** The model, or null for a call that has none: priced under the vendor's `*` entry. */
  readonly model: string | null;
  /** A unit kind to its count in the call. */
  readonly units: Readonly<Record<string, number>>;
};
export type Priced = { readonly unit_cost: string; readonly price_list_version: string };

/** Fixed-point, no exponent, no grouping, up to 15 significant digits: what numeric takes exactly. */
const decimal = new Intl.NumberFormat("en-US", {
  useGrouping: false,
  maximumSignificantDigits: 15,
});

const errors = defineErrors({ cost_price_missing: {} });

/**
 * What the units cost at the table's prices: the sum over the unit kinds of count times the price per
 * unit, as a fixed-point decimal string of up to 15 significant digits, with the list's version. A
 * vendor, model or unit kind the table does not price is `cost_price_missing`: a wrong price is worse
 * than a loud one.
 */
export function priceFor(table: PriceTable, { vendor, model, units }: PriceLookup): Priced {
  const prices = table.prices[vendor]?.[model ?? NO_MODEL];
  let total = 0;
  for (const [kind, count] of Object.entries(units)) {
    const price = prices?.[kind];
    if (price === undefined) {
      throw new AppError(errors.cost_price_missing, {
        details: { vendor, model, kind, price_list_version: table.version },
      });
    }
    total += count * price;
  }
  return { unit_cost: decimal.format(total), price_list_version: table.version };
}

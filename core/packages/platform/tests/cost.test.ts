// Unit tests of cost (alpha-p1-055): the price-table lookup, pure, and the table's JSON shape as
// COST_PRICES_JSON carries it. recordCost itself is proven end to end in core/packages/db.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineConfig } from "../config/index.ts";
import { type PriceTable, priceFor, priceTableJson } from "../cost/index.ts";
import { throwsCode } from "../testing/index.ts";

const table: PriceTable = {
  version: "2026-10-21",
  prices: {
    "example-llm": {
      "example-model": { input_tokens: 0.000003, output_tokens: 0.000015, micro: 0.00000025 },
    },
    "example-pages": { "*": { pages: 0.002 } },
  },
};
const llm = { vendor: "example-llm", model: "example-model" };

test("priceFor sums count times price over the unit kinds, as a decimal string, with the version", () => {
  assert.deepEqual(priceFor(table, { ...llm, units: { input_tokens: 1000, output_tokens: 200 } }), {
    unit_cost: "0.006",
    price_list_version: "2026-10-21",
  });
  assert.equal(priceFor(table, { ...llm, units: { input_tokens: 1 } }).unit_cost, "0.000003");
  assert.equal(priceFor(table, { ...llm, units: { input_tokens: 0 } }).unit_cost, "0");
  assert.equal(
    priceFor(table, { ...llm, units: { micro: 1 } }).unit_cost,
    "0.00000025",
    "fixed-point, never an exponent",
  );
  assert.equal(
    priceFor(table, { vendor: "example-pages", model: null, units: { pages: 3 } }).unit_cost,
    "0.006",
    "a call without a model is priced under the vendor's * entry",
  );
  const noisy: PriceTable = { version: "v", prices: { v: { m: { a: 0.1, b: 0.2 } } } };
  assert.equal(
    priceFor(noisy, { vendor: "v", model: "m", units: { a: 1, b: 1 } }).unit_cost,
    "0.3",
  );
});

test("a vendor, model or unit kind the table does not price is cost_price_missing, never a guess", () => {
  const units = { input_tokens: 1 };
  throwsCode(
    () => priceFor(table, { vendor: "nobody", model: "example-model", units }),
    "cost_price_missing",
  );
  throwsCode(() => priceFor(table, { ...llm, model: "other-model", units }), "cost_price_missing");
  throwsCode(() => priceFor(table, { ...llm, model: null, units }), "cost_price_missing");
  throwsCode(
    () => priceFor(table, { ...llm, units: { input_tokens: 1, images: 1 } }),
    "cost_price_missing",
  );
});

test("COST_PRICES_JSON is the table as JSON: parsed at start, optional, a fault named as config_invalid", () => {
  const shape = { COST_PRICES_JSON: priceTableJson.optional() };
  const env = { COST_PRICES_JSON: JSON.stringify(table) };
  assert.deepEqual(defineConfig("tests/fixture", shape, env).COST_PRICES_JSON, table);
  assert.equal(defineConfig("tests/fixture", shape, {}).COST_PRICES_JSON, undefined);
  assert.equal(
    defineConfig("tests/fixture", shape, { COST_PRICES_JSON: "" }).COST_PRICES_JSON,
    undefined,
  );
  for (const text of [
    "{",
    "[]",
    '{"version":"v","prices":{},"vendors":{}}',
    '{"version":"v"}',
    '{"prices":{}}',
    '{"version":"v","prices":{"a":{"m":{"t":"free"}}}}',
    '{"version":"v","prices":{"a":{"m":{"t":-1}}}}',
  ]) {
    throwsCode(
      () => defineConfig("tests/fixture", shape, { COST_PRICES_JSON: text }),
      "config_invalid",
    );
  }
});

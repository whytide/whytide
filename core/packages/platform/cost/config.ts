// The price table as a variable of the platform's block (coding §8), parsed at import so a malformed
// table fails at start, naming the variable. Optional: a host without provider or model calls (the
// web) imports the package without it, and recordCost refuses to price a call while it is unset.
// Documented at the end of the packages/platform block of deploy/.env.example.
import { defineConfig } from "../config/define.ts";
import { priceTableJson } from "./prices.ts";

export const costConfig = defineConfig("packages/platform", {
  COST_PRICES_JSON: priceTableJson.optional(),
});

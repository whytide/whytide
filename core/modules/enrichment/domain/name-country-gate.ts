// The country namer's gate (agents/name-country/README.md, gamma-en-075): `country` is two capital
// letters or null. callAgent retries a failure once, then records ai_failed. Pure.
import type { GateResult } from "@whytide/ai";
import type { NameCountryOutput } from "../schemas/name-country.ts";
import { COUNTRY_CODE } from "./constants.ts";

export function countryCodeGate(output: NameCountryOutput): GateResult {
  const off = output.country !== null && !COUNTRY_CODE.test(output.country);
  const issue = { path: "country", message: "two capital letters, or null" };
  return { gate: "country_code", issues: off ? [issue] : [] };
}

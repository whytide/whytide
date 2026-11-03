// The rules of the ICP (docs/concepts.md): its targeting fields as the commands store them, the
// version decision and the weights. Plain TypeScript, unit-tested in tests/domain.test.ts. The
// lengths and counts are the PUT body's schema (schemas/icp.ts), from the limits of lists.ts.
import { AppError } from "@whytide/platform";
import { errors } from "../errors.ts";
import { COUNTRIES, SENIORITIES, type Seniority, SIZE_RANGES, type SizeRange } from "./lists.ts";

/** What saveIcp takes: the name and the targeting fields, as the PUT body carries them. */
export type IcpFields = {
  readonly name: string;
  readonly titles: readonly string[];
  readonly seniorities: readonly string[];
  readonly industries: readonly string[];
  readonly sizeRanges: readonly string[];
  readonly countries: readonly string[];
  readonly mustHaves: string;
  readonly disqualifiers: string;
};

/** The targeting fields, every field but the name, as stored. */
export type Targeting = {
  readonly titles: string[];
  readonly seniorities: Seniority[];
  readonly industries: string[];
  readonly sizeRanges: SizeRange[];
  readonly countries: string[];
  readonly mustHaves: string;
  readonly disqualifiers: string;
};

/**
 * The targeting fields as saveIcp stores them: titles, industries and texts trimmed, no duplicates,
 * seniorities and size ranges in their list's order, countries upper-case in code order. A value off
 * a closed list is its code (icp_unknown_seniority, …), `details.fields` naming each one's path.
 */
export function targetingOf(fields: IcpFields): Targeting {
  const countries = fields.countries.map((code) => code.toUpperCase());
  return {
    titles: distinct(fields.titles.map((title) => title.trim())),
    seniorities: closed(
      fields.seniorities,
      SENIORITIES,
      "seniorities",
      errors.icp_unknown_seniority,
    ),
    industries: distinct(fields.industries.map((industry) => industry.trim())),
    sizeRanges: closed(fields.sizeRanges, SIZE_RANGES, "sizeRanges", errors.icp_unknown_size_range),
    countries: closed(countries, COUNTRIES, "countries", errors.icp_unknown_country),
    mustHaves: fields.mustHaves.trim(),
    disqualifiers: fields.disqualifiers.trim(),
  };
}

/** Whether saving `next` over `stored` changes the targeting: the lists compared as sets. */
export function targetingChanged(stored: Targeting, next: Targeting): boolean {
  const lists = ["titles", "seniorities", "industries", "sizeRanges", "countries"] as const;
  const texts = ["mustHaves", "disqualifiers"] as const;
  return (
    lists.some((field) => !sameSet(stored[field], next[field])) ||
    texts.some((field) => stored[field] !== next[field])
  );
}

/** A new ICP's targeting: every list and text empty. */
const NO_TARGETING: Targeting = {
  ...{ titles: [], seniorities: [], industries: [], sizeRanges: [], countries: [] },
  ...{ mustHaves: "", disqualifiers: "" },
};

/** Whether any targeting field holds a value: the draft script replaces it only with --replace. */
export function hasTargeting(targeting: Targeting): boolean {
  return targetingChanged(NO_TARGETING, targeting);
}

/** The criteria's weights sum to 100, or icp_weights_must_sum_100 with `details.sum`. */
export function checkWeights(criteria: readonly { readonly weight: number }[]): void {
  const sum = criteria.reduce((total, { weight }) => total + weight, 0);
  if (sum !== 100) throw new AppError(errors.icp_weights_must_sum_100, { details: { sum } });
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** The list's values that `values` holds, in the list's order; any other value is `code`. */
function closed<T extends string>(
  values: readonly string[],
  list: readonly T[],
  field: string,
  code: string,
): T[] {
  const known: readonly string[] = list;
  const unknown = values.flatMap((value, at) => (known.includes(value) ? [] : [`${field}.${at}`]));
  if (unknown.length > 0) throw new AppError(code, { details: { fields: unknown } });
  return list.filter((value) => values.includes(value));
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const inB = new Set(b);
  return new Set(a).size === inB.size && a.every((value) => inB.has(value));
}

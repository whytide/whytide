// The company-size rule of the hard filters (docs/concepts.md "Company size"). contacts keeps a
// company's size as its source wrote it; this reads that text as the ranges of icp's closed list it
// can fall in (decisions.md, 2026-10-22). tests/fixtures/sizes.json documents the parser.

/** icp's closed list (its README "The record"), with each range's bounds in employees. */
const RANGES = [
  ["1-10", 1, 10],
  ["11-50", 11, 50],
  ["51-200", 51, 200],
  ["201-500", 201, 500],
  ["501-1000", 501, 1000],
  ["1001-5000", 1001, 5000],
  ["5001+", 5001, Number.POSITIVE_INFINITY],
] as const;
export type SizeRange = (typeof RANGES)[number][0];

/** A count: `1,000`, `1.000` or `1000`, and `k` for thousands. */
const COUNT = String.raw`(\d{1,3}(?:[,.]\d{3})+|\d+)(k?)`;
/** `11-50`, `11 – 50`, `11 to 50`, `10,001+`, `10000 or more` or `35`, once the words are gone. */
const SIZE = new RegExp(String.raw`^${COUNT}(?:\s*(?:-|–|—|to)\s*${COUNT}|\s*(\+|or more))?$`);
const WORDS = /\b(?:employees?|people|staff)\b/g;

/**
 * The ranges of icp's list that a size written as free text falls in: `11-50 employees` is 11-50,
 * `5,001-10,000` and `10,001+` are 5001+, `1-50` is 1-10 and 11-50. Null when the text reads as no
 * count of employees: the size is unknown.
 */
export function sizeRangesOf(text: string): SizeRange[] | null {
  const match = SIZE.exec(text.toLowerCase().replace(WORDS, " ").trim());
  if (match === null) return null;
  const [, from, fromK, to, toK, open] = match;
  const low = count(from, fromK);
  const high = open ? Number.POSITIVE_INFINITY : to === undefined ? low : count(to, toK);
  if (high < 1 || low > high) return null;
  return RANGES.filter(([, min, max]) => low <= max && high >= min).map(([range]) => range);
}

function count(digits: string | undefined, thousands: string | undefined): number {
  return Number((digits ?? "").replace(/[,.]/g, "")) * (thousands ? 1000 : 1);
}

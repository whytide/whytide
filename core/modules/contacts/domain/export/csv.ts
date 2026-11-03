// The CSV that contacts writes (docs/security.md "What leaves"), pure: RFC 4180 lines ended by CRLF,
// and every cell that a spreadsheet would read as a formula neutralized by a leading apostrophe
// (docs/rules/security.md §2).

/** A cell's first character that a spreadsheet takes for a formula or a control. */
const FORMULA = /^[=+\-@\t\r]/;

/** The text a spreadsheet shows and never runs: an apostrophe before a formula's first character. */
export function neutralize(text: string): string {
  return FORMULA.test(text) ? `'${text}` : text;
}

/** One cell: empty for no value, neutralized, then quoted when it holds a comma, a quote or a break. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = neutralize(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A line of cells. */
export function csvLine(cells: readonly (string | number | null | undefined)[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

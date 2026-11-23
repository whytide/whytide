// The check of a sources CSV's rows (README.md "Importing sources"; sources-csv-import): each row's
// kind by its name, the registry's or its CSV's (a kind without `csv` is not importable); its config
// from its cells, read by the kind's schema as a create reads it (a post's short link resolved, so
// outside any run); its label, the row's or the kind's; then a row that repeats an earlier one, or a
// source of the workspace, by kind and stored config. A row's code is a line of the answer, never an
// error of the request: a create's error code, or one of ROW_CODES, with the columns it names.
import { isAppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import type { SourceKind } from "../../sources/_contract.ts";
import { LABEL_MAX_CHARS } from "../../sources/constants.ts";
import { parseSourceConfig, registeredSourceKinds } from "../../sources/registry.ts";
import { ROW_CODES } from "./constants.ts";
import type { ImportRow } from "./csv.ts";

/** A valid row: the source it makes, its config as the kind stores it. */
export type CheckedRow = {
  readonly row: number;
  readonly kind: string;
  readonly config: unknown;
  readonly label: string;
};
/** A row not imported: its number, its code and the file's columns the code is about. */
export type RowError = { readonly row: number; readonly code: string; readonly columns: string[] };
export type Checked = {
  /** The data rows read. */
  readonly rows: number;
  readonly valid: readonly CheckedRow[];
  /** In the rows' order. */
  readonly errors: readonly RowError[];
};

/** The importable kind a `kind` cell names, by its name or one of its CSV's, in any case. */
export function importKind(cell: string): SourceKind | undefined {
  const name = cell.toLowerCase();
  for (const kind of registeredSourceKinds().values()) {
    if (kind.csv !== undefined && (kind.kind === name || kind.csv.names.includes(name)))
      return kind;
  }
  return undefined;
}

/** A row read: the source it makes, or its code. Outside any run: a post's short link calls out. */
export async function readRow(row: ImportRow): Promise<CheckedRow | RowError> {
  const kind = importKind(row.kind);
  const csv = kind?.csv;
  if (kind === undefined || csv === undefined) {
    return { row: row.row, code: errors.signal_kind_unknown, columns: ["kind"] };
  }
  let config: unknown;
  try {
    config = await parseSourceConfig(kind, csv.config(row.cells));
  } catch (error) {
    // The kind's refusals, signal_config_invalid and signal_topic_blocked naming their fields, and a
    // short link's signal_post_link_unreachable: the create's codes, the fields as the file's columns.
    if (!isAppError(error)) throw error;
    const fields = (error.details as { fields?: unknown } | undefined)?.fields;
    const named = Array.isArray(fields) ? fields.map((field) => csv.columns[String(field)]) : [];
    const columns = [...new Set(named.filter((column) => column !== undefined))];
    return { row: row.row, code: error.code, columns };
  }
  const label =
    row.label === "" ? Array.from(csv.label(config)).slice(0, LABEL_MAX_CHARS) : [...row.label];
  if (label.length > LABEL_MAX_CHARS) {
    return { row: row.row, code: errors.signal_config_invalid, columns: ["label"] };
  }
  return { row: row.row, kind: kind.kind, config, label: label.join("") };
}

/**
 * The rows read, in the file's order: the valid ones, but a row whose kind and config an earlier row
 * has (duplicate_in_file) or a source of `existing` has (source_exists), and the errors.
 */
export function checkRows(
  read: readonly (CheckedRow | RowError)[],
  existing: ReadonlySet<string>,
): Checked {
  const seen = new Set<string>();
  const valid: CheckedRow[] = [];
  const refused: RowError[] = [];
  for (const one of read) {
    if ("code" in one) {
      refused.push(one);
      continue;
    }
    const key = sourceKey(one.kind, one.config);
    if (seen.has(key)) refused.push({ row: one.row, code: ROW_CODES.duplicate, columns: [] });
    else if (existing.has(key)) refused.push({ row: one.row, code: ROW_CODES.exists, columns: [] });
    else valid.push(one);
    seen.add(key);
  }
  return { rows: read.length, valid, errors: refused };
}

/** A source's identity: its kind and its config as stored, the keys in order, as jsonb keeps none. */
export function sourceKey(kind: string, config: unknown): string {
  const sorted = (_key: string, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value;
  return `${kind}:${JSON.stringify(config, sorted)}`;
}

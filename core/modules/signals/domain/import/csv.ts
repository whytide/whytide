// The reader of a sources CSV (README.md "Importing sources"; sources-csv-import), as discovery's reader
// checks an upload: a name not *.csv, or what is not text (a ZIP signature at the start, as an .xlsx
// has, or a NUL byte), is refused, so is what is not UTF-8 (a byte-order mark is fine), and the bytes
// and the data rows are counted against the limits. csv-parse gets no cast, no `on_record` and no
// `info`: every cell stays a string, never evaluated. A malformed file (an unclosed quote, a row of
// another width than the header, a record over 64 KiB) is refused whole. The header row names the
// columns, in any order and case: `kind`, required, then `url`, `name`, `phrase`, `roles` and
// `label`; any other column is not read. A megabyte at most, so the file is read at once.
import { AppError } from "@whytide/platform";
import { CsvError, parse } from "csv-parse/sync";
import { errors } from "../../errors.ts";
import type { ImportCells } from "../../sources/_contract.ts";
import {
  COLUMNS,
  type Column,
  CSV_NAME,
  MAX_RECORD_BYTES,
  SOURCE_IMPORT_MAX_BYTES,
  SOURCE_IMPORT_MAX_ROWS,
  ZIP_SIGNATURE,
} from "./constants.ts";

/** A data row: its record's number in the file, the header's being 1, and its cells, trimmed. */
export type ImportRow = {
  readonly row: number;
  readonly kind: string;
  readonly cells: ImportCells;
  readonly label: string;
};

/** The file's data rows, in its order; a refusal of the whole file throws its code. */
export function readSourcesCsv(name: string, bytes: Uint8Array): ImportRow[] {
  const unsupported = () => new AppError(errors.signal_import_unsupported_type);
  if (!CSV_NAME.test(name)) throw unsupported();
  if (bytes.length > SOURCE_IMPORT_MAX_BYTES) throw new AppError(errors.signal_import_too_large);
  const zip = ZIP_SIGNATURE.every((byte, at) => bytes[at] === byte);
  if (zip || bytes.includes(0)) throw unsupported();
  let text: string;
  try {
    // The decoder drops a byte-order mark and throws a TypeError on bytes that are not UTF-8.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AppError(errors.signal_import_bad_encoding);
  }
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      columns: false,
      max_record_size: MAX_RECORD_BYTES,
      record_delimiter: ["\r\n", "\n", "\r"],
      relax_column_count: false,
      skip_empty_lines: true,
    });
  } catch (error) {
    throw error instanceof CsvError ? unsupported() : error;
  }
  const [header, ...data] = records;
  if (header === undefined) throw new AppError(errors.signal_import_missing_column);
  const at = columnsOf(header);
  const rows: ImportRow[] = [];
  data.forEach((cells, index) => {
    // A row of empty cells, as a spreadsheet writes for a blank row, is no data row.
    if (cells.every((cell) => cell.trim() === "")) return;
    if (rows.length === SOURCE_IMPORT_MAX_ROWS) {
      throw new AppError(errors.signal_import_too_many_rows);
    }
    // An absent column's place, -1, holds no cell: "".
    const cell = (column: Column) => cells[at[column]]?.trim() ?? "";
    const values = { url: cell("url"), name: cell("name"), phrase: cell("phrase") };
    const label = cell("label");
    rows.push({
      row: index + 2,
      kind: cell("kind"),
      cells: { ...values, roles: cell("roles") },
      label,
    });
  });
  return rows;
}

/** Each column's place in the header, -1 when absent; signal_import_missing_column without `kind`. */
function columnsOf(header: readonly string[]): Record<Column, number> {
  const names = header.map((cell) => cell.trim().toLowerCase());
  const at = Object.fromEntries(COLUMNS.map((column) => [column, names.indexOf(column)]));
  if (at.kind === -1) throw new AppError(errors.signal_import_missing_column);
  return at as Record<Column, number>;
}

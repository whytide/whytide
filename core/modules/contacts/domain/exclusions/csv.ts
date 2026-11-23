// The reader of an exclusion list's file (README.md "Exclusion lists"; docs/security.md), discovery's
// reader in contacts' words, since contacts imports no other module: the bytes as they arrive, never
// loaded whole before they are checked, never evaluated, never kept. What is not text is refused (a
// ZIP signature at the start, as an .xlsx has, or a NUL byte), so is what is not UTF-8 (a byte-order
// mark is fine), and the bytes and the data rows are counted against the limits: the first past one
// throws, which ends the parser and the source, and the caller stops reading the request. csv-parse
// gets no cast, no `on_record`, no `raw` and no `info`: every cell stays a string. A malformed file
// (an unclosed quote, a row of another width than the header, a record over 64 KiB) is refused
// whole. The header row names the `domain` column, in any case; any other column is not read.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "@whytide/platform";
import { CsvError, parse } from "csv-parse";
import { errors } from "../../errors.ts";
import { DOMAIN_COLUMN, MAX_RECORD_BYTES, ZIP_SIGNATURE } from "./constants.ts";
import { type ExclusionFile, ExclusionRows } from "./rows.ts";

export type CsvLimits = { readonly maxBytes: number; readonly maxRows: number };

const ZIP = Buffer.from(ZIP_SIGNATURE, "latin1");

/** Reads the file to its end: each data row's domain, or why it has none (rows.ts). */
export async function readExclusionFile(
  file: AsyncIterable<Uint8Array>,
  limits: CsvLimits,
): Promise<ExclusionFile> {
  let size = 0;
  async function* checked() {
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    let head = Buffer.alloc(0);
    for await (const chunk of file) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limits.maxBytes) throw new AppError(errors.exclusions_too_large);
      if (head.length < ZIP.length) head = Buffer.concat([head, bytes]).subarray(0, ZIP.length);
      if (head.equals(ZIP) || bytes.includes(0)) {
        throw new AppError(errors.exclusions_unsupported_type);
      }
      utf8Only(() => utf8.decode(bytes, { stream: true }));
      yield bytes;
    }
    utf8Only(() => utf8.decode());
  }
  const parser = parse({
    bom: true,
    columns: false,
    max_record_size: MAX_RECORD_BYTES,
    record_delimiter: ["\r\n", "\n", "\r"],
    relax_column_count: false,
    skip_empty_lines: true,
  });
  // Settles with the failure rather than rejecting: the loop below meets the same one first.
  const fed = pipeline(Readable.from(checked()), parser).then(
    () => undefined,
    (error: unknown) => error,
  );
  const rows = new ExclusionRows();
  let column: number | undefined;
  let record = 0;
  let count = 0;
  try {
    for await (const cells of parser as AsyncIterable<string[]>) {
      record += 1;
      if (column === undefined) {
        column = domainColumn(cells);
        continue;
      }
      // A row of empty cells, as a spreadsheet writes for a blank row, is no data row.
      if (cells.every((cell) => cell.trim() === "")) continue;
      count += 1;
      if (count > limits.maxRows) throw new AppError(errors.exclusions_too_many_rows);
      rows.add(record, cells[column] ?? "");
    }
    const failed = await fed;
    if (failed !== undefined) throw failed;
  } catch (error) {
    throw error instanceof CsvError ? new AppError(errors.exclusions_unsupported_type) : error;
  }
  if (column === undefined) throw new AppError(errors.exclusions_missing_column);
  return rows.file();
}

/** The header row's `domain` column, trimmed and in any case; exclusions_missing_column without one. */
function domainColumn(cells: readonly string[]): number {
  const column = cells.findIndex((cell) => cell.trim().toLowerCase() === DOMAIN_COLUMN);
  if (column === -1) throw new AppError(errors.exclusions_missing_column);
  return column;
}

/** The decoder throws a TypeError on bytes that are not UTF-8: exclusions_bad_encoding. */
function utf8Only(decode: () => string): void {
  try {
    decode();
  } catch {
    throw new AppError(errors.exclusions_bad_encoding);
  }
}

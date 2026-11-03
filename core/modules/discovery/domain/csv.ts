// The CSV reader of an upload (README.md "POST …/imports"; docs/security.md): the file's bytes as they
// arrive, never loaded whole before they are checked, never evaluated. What is not text is refused (a
// ZIP signature at the start, as an .xlsx has, or a NUL byte), so is what is not UTF-8 (a byte-order
// mark is fine), and the bytes and the data rows are counted against the limits: the first past one
// throws, which ends the parser and the source, and the caller stops reading the request. csv-parse
// gets no cast, no `on_record`, no `raw` and no `info`: every cell stays a string. A malformed file
// (an unclosed quote, a row of another width than the header, a record over 64 KiB) is refused
// whole. The header row names the columns: linkedin_url, required, name and company, optional, in
// any order and case; any other column is not read.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "@whytide/platform";
import { CsvError, parse } from "csv-parse";
import { errors } from "../errors.ts";

export type CsvLimits = { readonly maxBytes: number; readonly maxRows: number };
/** A data row: its record's number in the file, the header's being 1, and its cells, as text. */
export type CsvRow = {
  readonly row: number;
  readonly linkedinUrl: string;
  readonly name: string | undefined;
  readonly company: string | undefined;
};
type Columns = { readonly linkedinUrl: number; readonly name: number; readonly company: number };

const ZIP = Buffer.from("PK\x03\x04", "latin1");
/** The longest record csv-parse holds; past it the file is malformed. */
const MAX_RECORD_BYTES = 65_536;

/** Reads the file to its end, calling `onRow` for each data row; returns its bytes, for the store. */
export async function readCsv(
  file: AsyncIterable<Uint8Array>,
  limits: CsvLimits,
  onRow: (row: CsvRow) => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  async function* checked() {
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    let head = Buffer.alloc(0);
    for await (const chunk of file) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limits.maxBytes) throw new AppError(errors.import_too_large);
      if (head.length < ZIP.length) head = Buffer.concat([head, bytes]).subarray(0, ZIP.length);
      if (head.equals(ZIP) || bytes.includes(0)) throw new AppError(errors.import_unsupported_type);
      utf8Only(() => utf8.decode(bytes, { stream: true }));
      chunks.push(bytes);
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
  let columns: Columns | undefined;
  let record = 0;
  let rows = 0;
  try {
    for await (const cells of parser as AsyncIterable<string[]>) {
      record += 1;
      if (columns === undefined) {
        columns = header(cells);
        continue;
      }
      // A row of empty cells, as a spreadsheet writes for a blank row, is no data row.
      if (cells.every((cell) => cell.trim() === "")) continue;
      rows += 1;
      if (rows > limits.maxRows) throw new AppError(errors.import_too_many_rows);
      const cell = (at: number) => (at === -1 ? undefined : cells[at]);
      onRow({
        row: record,
        linkedinUrl: cell(columns.linkedinUrl) ?? "",
        name: cell(columns.name),
        company: cell(columns.company),
      });
    }
    const failed = await fed;
    if (failed !== undefined) throw failed;
  } catch (error) {
    throw error instanceof CsvError ? new AppError(errors.import_unsupported_type) : error;
  }
  if (columns === undefined) throw new AppError(errors.import_missing_column);
  return Buffer.concat(chunks, size);
}

/** The header row's columns, trimmed and in any case; import_missing_column without linkedin_url. */
function header(cells: readonly string[]): Columns {
  const names = cells.map((cell) => cell.trim().toLowerCase());
  const linkedinUrl = names.indexOf("linkedin_url");
  if (linkedinUrl === -1) throw new AppError(errors.import_missing_column);
  return { linkedinUrl, name: names.indexOf("name"), company: names.indexOf("company") };
}

/** The decoder throws a TypeError on bytes that are not UTF-8: import_bad_encoding. */
function utf8Only(decode: () => string): void {
  try {
    decode();
  } catch {
    throw new AppError(errors.import_bad_encoding);
  }
}

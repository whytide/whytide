// A sources CSV's limits and names (README.md "Importing sources"; sources-csv-import): its size, its
// rows, the request that carries it, its columns, the row codes the check answers besides a create's
// error codes, and the imports a list answers. The screen reads the size before an upload.

/** A file's size at most, in megabytes, as the screen says it. */
export const SOURCE_IMPORT_MAX_MEGABYTES = 1;
/** A file's bytes at most. */
export const SOURCE_IMPORT_MAX_BYTES = SOURCE_IMPORT_MAX_MEGABYTES * 1_048_576;
/** Its data rows at most, the header aside. */
export const SOURCE_IMPORT_MAX_ROWS = 200;
/**
 * The request's body at most: the file in base64 is four thirds of its bytes, and twice the file's
 * limit lets a file a little over it be told signal_import_too_large rather than payload_too_large.
 */
export const SOURCE_IMPORT_BODY_BYTES = 2 * SOURCE_IMPORT_MAX_BYTES;
/** The longest record csv-parse holds; past it the file is malformed. */
export const MAX_RECORD_BYTES = 65_536;
/** The kept file name's length at most: a longer one keeps its first characters. */
export const FILE_NAME_MAX_CHARS = 255;
/** A file's name: *.csv, in any case. */
export const CSV_NAME = /\.csv$/i;
/** The first bytes of a ZIP, an .xlsx's: no CSV. */
export const ZIP_SIGNATURE = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
/** The columns a header row may name, in any case and order; `kind` is required. */
export const COLUMNS = ["kind", "url", "name", "phrase", "roles", "label"] as const;
export type Column = (typeof COLUMNS)[number];
/** The row codes of the check that no create answers: a row before it, a source of the workspace. */
export const ROW_CODES = { duplicate: "duplicate_in_file", exists: "source_exists" } as const;
/** The source imports GET …/sources/imports answers at most, the newest first. */
export const SOURCE_IMPORTS_LISTED = 100;

// The bodies and answers of the source imports routes (README.md "Importing sources";
// sources-csv-import), from which the api host builds the OpenAPI document. The file travels in the
// JSON body as base64, with its name and the sender account of every row: the host reads JSON itself,
// and the module checks the name, the bytes and the rows (domain/import/).
import { z } from "zod";
import { SOURCE_IMPORT_BODY_BYTES } from "../domain/import/constants.ts";
import { senderAccountId } from "./sources.ts";

/** The longest file name the body takes; the import keeps its first 255 characters. */
const FILE_NAME_MAX = 1_024;

export const sourceImportBody = z.strictObject({
  /** The file's name as picked: *.csv, else signal_import_unsupported_type. */
  fileName: z.string().min(1).max(FILE_NAME_MAX),
  /** The file's bytes in base64: a megabyte at most once decoded, else signal_import_too_large. */
  file: z.base64().max(SOURCE_IMPORT_BODY_BYTES),
  /** One of the workspace's sender accounts, connected or not: every row's source reads through it. */
  senderAccountId,
});
export type SourceImportBody = z.infer<typeof sourceImportBody>;

/** A row not imported: its record's number (the header's is 1), its code, the columns it names. */
const rowError = z.strictObject({
  row: z.number().int(),
  code: z.string(),
  columns: z.array(z.string()),
});

export const sourceImportCheckResponse = z.strictObject({
  fileName: z.string(),
  /** The data rows read, the header and blank rows aside. */
  rows: z.number().int(),
  /** The rows an import creates, in the file's order: each one's kind and label. */
  valid: z.array(z.strictObject({ row: z.number().int(), kind: z.string(), label: z.string() })),
  errors: z.array(rowError),
});
export type SourceImportCheckResponse = z.infer<typeof sourceImportCheckResponse>;

export const sourceImportResponse = z.strictObject({
  id: z.string(),
  fileName: z.string(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  /** The sources its rows created, the disabled ones among them. */
  created: z.number().int(),
  /** Of those, the ones created disabled, past SIGNALS_MAX_ENABLED_SOURCES or the account's tracked limit. */
  disabled: z.number().int(),
  /** The rows not imported. */
  refused: z.number().int(),
});
export type SourceImportResponse = z.infer<typeof sourceImportResponse>;

export const sourceImportResultResponse = z.strictObject({
  sourceImport: sourceImportResponse,
  /** Every row not imported, in the file's order: the check's and the creates' refusals. */
  errors: z.array(rowError),
});
export type SourceImportResultResponse = z.infer<typeof sourceImportResultResponse>;

export const sourceImportListResponse = z.strictObject({ imports: z.array(sourceImportResponse) });

// discovery's codes (core/packages/platform/README.md "Errors"), each with its key in
// messages/en.json. The upload's codes are about the file as a whole; a row's codes are no errors
// but the report's (domain/rows.ts).
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** POST …/imports: no file part named *.csv, or its content is not text (a ZIP signature, a NUL byte) or not CSV. 400. */
  import_unsupported_type: { status: 400 },
  /** The file is over IMPORT_MAX_BYTES: the reading stopped there. 413. */
  import_too_large: { status: 413 },
  /** The file has more than IMPORT_MAX_ROWS data rows: the reading stopped at the next one. 400. */
  import_too_many_rows: { status: 400 },
  /** The file has no header row with a linkedin_url column. 400. */
  import_missing_column: { status: 400 },
  /** The file is not UTF-8. 400. */
  import_bad_encoding: { status: 400 },
  /** GET …/imports/{job} and its run: the workspace has no import with this id. 404. */
  import_not_found: {},
  /** POST …/imports/{job}/run: the job is not validated; it ran, runs, failed or has no valid row. 409. */
  import_not_runnable: { status: 409 },
  /** The run: a chunk failed on an error with no code; the job is failed at it (its failure's code). 500. */
  import_failed: { status: 500 },
});

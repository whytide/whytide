// The exclusion lists' words and limits (gamma-p2-045; README.md "Exclusion lists"), beside the code
// that reads them: the settings, the reader, the cell rules, the import, the routes and the screen.

/** The data rows a file may hold by default, and the most the setting allows. */
export const IMPORT_MAX_ROWS_DEFAULT = 5_000;
export const IMPORT_MAX_ROWS_LIMIT = 10_000;

/** The bytes a file may hold by default, 1 MiB, and the most the setting allows, 5 MiB. */
export const IMPORT_MAX_BYTES_DEFAULT = 1_048_576;
export const IMPORT_MAX_BYTES_LIMIT = 5_242_880;

/** A request's body may hold twice the file's limit, so a file a little over it is told so. */
export const BODY_LIMIT_FACTOR = 2;

/** How long an upload may take, two minutes; past it the request is refused. */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** The first bytes of a ZIP archive, an .xlsx among them: such a file is no CSV. */
export const ZIP_SIGNATURE = "PK\x03\x04";

/** The longest record csv-parse holds, 64 KiB; past it the file is malformed. */
export const MAX_RECORD_BYTES = 65_536;

/** The column that holds the domains, named in the header in any case. */
export const DOMAIN_COLUMN = "domain";

/** The extension the file's name ends in, in any case. */
export const CSV_NAME = /\.csv$/i;

/** A list's name is the file's, its first characters up to this many. */
export const LIST_NAME_MAX = 200;

/** The entries one statement writes, and so the leads one pass moves. */
export const IMPORT_CHUNK = 1_000;

/** The rows without an entry an answer names at most, the first ones by record number. */
export const ROWS_SHOWN = 100;

/** Why a row added no entry: no domain in its cell, or a domain the file or the list had already. */
export const ROW_CODES = ["domain_invalid", "duplicate"] as const;

/** The first characters that make a cell a formula to a spreadsheet: such a cell is no domain. */
export const FORMULA_PREFIXES = ["=", "+", "-", "@"] as const;

/** A cell may name the http or https scheme before its domain, and end in one slash. */
export const WEB_SCHEME = /^https?:\/\//i;
export const TRAILING_SLASH = /\/$/;

/**
 * What a domain never holds, past its scheme: an `@` (an email, credentials), a port's `:`, a
 * query's `?`, a fragment's `#`, a percent escape, a backslash, a space or a control character.
 */
export const NOT_IN_A_DOMAIN = /[@:?#%\\\s\p{Cc}]/u;

/**
 * The import's tenant run may last this long, past the 5 seconds of a request's: 10,000 rows took
 * 4.6 s with no lead to move and 13.2 s with 1,000 leads, on a loaded development laptop
 * (2026-11-13), and the leads a file holds have no limit but the workspace's.
 */
export const IMPORT_RUN_TIMEOUT_MS = 60_000;

/**
 * The transaction-scoped advisory lock an import and a removal take first, one per workspace
 * (review-gaps): `pg_advisory_xact_lock(hashtextextended('contacts.exclusions:<workspaceId>', 0))`,
 * so neither decides on the lists while the other's run is not committed.
 */
export const EXCLUSIONS_LOCK = "contacts.exclusions";

/** A removal's own work past its wait, a few set-based statements, at most this long. */
export const REMOVAL_WORK_MS = 15_000;

/**
 * A removal's run may last this long (review-gaps): it waits for an import of its workspace to end,
 * IMPORT_RUN_TIMEOUT_MS at most, then removes. Past it the run is rolled back whole.
 */
export const REMOVAL_RUN_TIMEOUT_MS = IMPORT_RUN_TIMEOUT_MS + REMOVAL_WORK_MS;

export type RowCode = (typeof ROW_CODES)[number];

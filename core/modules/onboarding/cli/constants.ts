// The fixed values of `pnpm knowledge:draft` (README "The script"), beside the code that reads them.

export const DRAFT_USAGE =
  "usage: pnpm knowledge:draft --workspace <id or slug> [--url <https://…>] [--file <path>]... [--accept [--replace-edited]]";

/**
 * The exit codes: drafted (and accepted with --accept); refused before any write; a usage error; the
 * run failed; a later Draft superseded it; the wait ran out while the worker goes on; no workspace
 * has the id or the slug, nothing written.
 */
export const EXIT = {
  done: 0,
  refused: 1,
  usage: 2,
  failed: 3,
  superseded: 4,
  timeout: 5,
  notFound: 6,
} as const;

export const DOCUMENT_LIMITS = {
  /** Files per Draft. */
  files: 5,
  /** Bytes per file, 10 MB. */
  bytes: 10 * 1024 * 1024,
  /**
   * Characters of text kept per document: the website fetch's FETCH_LIMITS.text, which the lint
   * keeps cli/ from importing from workflows/ (tests/documents.test.ts compares the two).
   */
  text: 50_000,
} as const;

/** The media type of each extension the script reads, in lower case. */
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

/**
 * PDF.js's options (docs/security.md "The documents"), with `data` and never a `url`: no fetch by its
 * worker side, the one way to a request with no font, character map or WebAssembly address set (none
 * is); no WebAssembly, so a type 4 function runs in PDF.js's interpreter; no warning on the console.
 * PDF.js 6.4 has no `isEvalSupported` any more: it runs no eval.
 */
export const PDF_OPTIONS = { useWorkerFetch: false, useWasm: false, verbosity: 0 } as const;

/** The wait for the worker's run: a read of the record every two seconds, ten minutes at most. */
export const WAIT = { everyMs: 2_000, forMs: 600_000 } as const;

/** The characters of a drafted text field the summary prints: its start. */
export const FIELD_START = 60;

/** The Company screen of the workspace, where a person reviews the draft. */
export const COMPANY_SCREEN = "/w/{workspace}/company";

// The site reader's bounds and codes (README "The site reader"): onboarding's website fetch's, moved
// here with the reader (gamma-en-065), so every caller reads sites within the same limits; a PDF
// file's own bounds (gamma-wr-020).
import { MAX_TITLE } from "./html.ts";
import { MAX_URL } from "./links.ts";

export const FETCH_LIMITS = {
  pageBytes: 1_048_576,
  /** A PDF file's bytes at most, checked before the parser sees one (5 MB). */
  pdfBytes: 5_242_880,
  /** A PDF file's pages at most, checked before any text is taken. */
  pdfPages: 50,
  pageMs: 10_000,
  /** The whole read's, when the caller gives no `totalMs`. */
  totalMs: 60_000,
  /** Characters of text kept per page. */
  text: 50_000,
  /** RFC 9309 asks a crawler to read 500 KiB of a robots.txt at least. */
  robotsBytes: 512_000,
  redirects: 5,
  /** Characters of a title kept. */
  title: MAX_TITLE,
  /** A page's final address at most; a longer link is never followed. */
  url: MAX_URL,
} as const;

/**
 * What a read that got no page answers besides the egress client's `egress_*` codes:
 * robots.txt lets nothing of the home page be read, or the home page is no readable HTML page.
 */
export const SITE_CODES = {
  disallowed: "site_disallowed",
  unreadable: "fetch_failed",
} as const;

/** The content types read as a page. */
export const HTML_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);
/** The content type read as a PDF file (`readPage` only). */
export const PDF_TYPE = "application/pdf";
/** What `readPage` asks for: a page, or a PDF file. */
export const PAGE_ACCEPT = `text/html,application/xhtml+xml,${PDF_TYPE};q=0.9`;

/**
 * unpdf's options for a file from the open web: nothing fetched (no worker file, no WebAssembly
 * decoder) and nothing printed. PDF.js gets the bytes as `data`, never a URL, and runs no script.
 */
export const PDF_OPTIONS = { useWorkerFetch: false, useWasm: false, verbosity: 0 } as const;
/** A control character of a PDF's text kept as a space: all but U+0000 (removed), a tab and a line break. */
export const CONTROL_CHARACTERS = /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g;
/** Half of a surrogate pair standing alone: it becomes U+FFFD. */
export const LONE_SURROGATE = /\p{Cs}/gu;

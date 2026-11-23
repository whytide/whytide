// The fixed values of the company's documents (README "The documents") and the defaults of their
// two settings (README "Settings"), the most pages a website fetch may read, a Draft's run's
// timeouts, the body a Draft request takes and the roles that may write the record, beside the code
// that reads them. No import: the screens, the workflow and settings.ts read them too.

/** The roles of company_knowledge.write (permissions.ts), whom the prompt at sign-in asks. */
export const COMPANY_KNOWLEDGE_WRITE_ROLES = ["Owner", "Admin"] as const;

/** The most pages ONBOARDING_FETCH_MAX_PAGES may name (settings.ts); the drafter's budget holds them. */
export const FETCH_MAX_PAGES = 10;

/**
 * A Draft's run, in milliseconds (README "The website fetch", "The drafter"): the start-to-close of
 * its fetch and of each attempt of its drafter, which the workflow sets (workflows/constants.ts), and
 * how long the screens and the script give a run before they call it stuck or stop waiting: more than
 * a fetch and a drafter's attempt together (tests/stuck.test.ts), so that a draft still working is
 * never offered a retry, which would supersede it.
 */
export const DRAFT_RUN_MS = {
  /** A little above the fetch's own sixty-second deadline, so a stalled site fails in one attempt. */
  fetch: 75_000,
  /** One model call on every page and document whole, then the gates' one retry. */
  draft: 15 * 60_000,
  /** The fetch's 75 seconds and the drafter's 15 minutes, with room. */
  stuck: 20 * 60_000,
} as const;

/**
 * The most bytes the api reads of a Draft request's JSON body, 10 MB: its route alone sets it, the
 * api's 1 MB staying for every other route (README "Settings"). A protection limit, no setting. The
 * texts are 50,000 characters at most each, three bytes a character at most in the JSON, so about
 * 69 full documents fit.
 */
export const DRAFT_BODY_BYTES = 10 * 1024 * 1024;

/** A drafted value's source when it comes from a document: `document:<name>`, never a web address. */
export const DOCUMENT_SOURCE = "document:";
/** A document's name: its file's base name, 1 to 255 characters, no control or format character. */
export const DOCUMENT_NAME = /^[^\p{C}/\\]{1,255}$/u;

/** The files a Draft takes at most, ONBOARDING_MAX_FILES's default (settings.ts). */
export const DOCUMENT_FILES = { default: 5 } as const;
/** The bytes of one file at most, ONBOARDING_MAX_FILE_BYTES's default (settings.ts): 10 MB. */
export const DOCUMENT_BYTES = { default: 10 * 1024 * 1024 } as const;

export const DOCUMENT_LIMITS = {
  /**
   * Characters of text kept per document: the website fetch's FETCH_LIMITS.text, which the lint
   * keeps domain/ from importing from workflows/ (tests/documents.test.ts compares the two).
   */
  text: 50_000,
} as const;

/** The media type of each extension a document may have, in lower case. */
export const DOCUMENT_TYPES = {
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
} as const;

/**
 * PDF.js's options (docs/security.md "The documents"), with `data` and never a `url`: no fetch by its
 * worker side, the one way to a request with no font, character map or WebAssembly address set (none
 * is); no WebAssembly, so a type 4 function runs in PDF.js's interpreter; no warning on the console.
 * PDF.js 6.4 has no `isEvalSupported` any more: it runs no eval.
 */
export const PDF_OPTIONS = { useWorkerFetch: false, useWasm: false, verbosity: 0 } as const;

/**
 * A control character a document's text keeps as a space: all but U+0000 (removed), a tab and a
 * line break. With a lone surrogate made U+FFFD, a text's JSON takes at most three bytes a
 * character, so a Draft's documents stay within the api's body limit (DRAFT_BODY_BYTES).
 */
export const CONTROL_CHARACTERS = /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g;
/** Half of a surrogate pair standing alone (in a PDF's text): it becomes U+FFFD. */
export const LONE_SURROGATE = /\p{Cs}/gu;

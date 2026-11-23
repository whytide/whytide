// The company's documents a Draft reads after the website's pages (README "The documents"): what the
// script and the Company screen hand requestDraft, the rules both read a file by (its type, its name,
// its size, its text and the cut), and a document's source in a draft, `document:<name>`, which the
// gates check like a page's address and the screen shows as the name, never as a link. Plain
// TypeScript, no import from Node: the screen imports it. unpdf is the caller's import (PDF.js sets
// globals on its first call): the script's, and the screen's, lazily; only its types come here. The
// limits of the files are settings (README "Settings"), which the screen never reads: each caller
// hands them in, the script from settings.ts, the screen from the record's answer.
import type { extractText, getDocumentProxy } from "unpdf";
import {
  CONTROL_CHARACTERS,
  DOCUMENT_LIMITS,
  DOCUMENT_NAME,
  DOCUMENT_SOURCE,
  DOCUMENT_TYPES,
  LONE_SURROGATE,
  PDF_OPTIONS,
} from "./constants.ts";

/** truncated: the document's text was cut at 50,000 characters. */
export type DocumentStatus = "read" | "truncated";
/** A document's media type: a PDF, Markdown or plain text. */
export type DocumentType = (typeof DOCUMENT_TYPES)[keyof typeof DOCUMENT_TYPES];
/** A document read: its file's base name, its media type, its status and its text. */
export type DraftDocument = {
  readonly name: string;
  readonly mediaType: DocumentType;
  readonly status: DocumentStatus;
  readonly text: string;
};
/** A document as the script prints it: its name and its status, never its text. */
export type DocumentRead = { readonly name: string; readonly status: DocumentStatus };
/** Why a file is not read: the script's codes, which the screen words too. */
export type DocumentRefusal =
  | "document_type_unsupported"
  | "document_name_invalid"
  | "document_not_found"
  | "document_too_large"
  | "document_no_text"
  | "document_encrypted"
  | "document_unreadable"
  | "documents_too_many"
  | "document_name_repeated";
/** A file's document, or the code that refuses it. */
export type DocumentResult =
  | { readonly ok: true; readonly document: DraftDocument }
  | { readonly ok: false; readonly code: DocumentRefusal };
/** The two functions of unpdf a PDF's text takes, from the caller's import. */
export type Unpdf = {
  readonly extractText: typeof extractText;
  readonly getDocumentProxy: typeof getDocumentProxy;
};
/** A Draft's documents at most, and one file's bytes at most (README "Settings"). */
export type DocumentLimits = { readonly files: number; readonly bytes: number };

/** Whether `name` may name a document: a base name, no control or format character. */
export const isDocumentName = (name: string): boolean => DOCUMENT_NAME.test(name);

/** The source a drafted value cites for the document `name`. */
export const documentSource = (name: string): string => `${DOCUMENT_SOURCE}${name}`;

/** The document's name when `source` is a document's source, else null (a page's address). */
export function documentName(source: string): string | null {
  if (!source.startsWith(DOCUMENT_SOURCE)) return null;
  const name = source.slice(DOCUMENT_SOURCE.length);
  return isDocumentName(name) ? name : null;
}

/** The media type of a file named `name`, by its extension in any case; undefined for another type. */
export function documentType(name: string): DocumentType | undefined {
  const dot = name.lastIndexOf(".");
  const extension = dot < 1 ? "" : name.slice(dot).toLowerCase();
  return Object.hasOwn(DOCUMENT_TYPES, extension)
    ? DOCUMENT_TYPES[extension as keyof typeof DOCUMENT_TYPES]
    : undefined;
}

/** A file's media type by its name, the first check (its type, then the name itself), or the refusal. */
export function documentKind(
  name: string,
):
  | { readonly ok: true; readonly mediaType: DocumentType }
  | { readonly ok: false; readonly code: DocumentRefusal } {
  const mediaType = documentType(name);
  if (mediaType === undefined) return { ok: false, code: "document_type_unsupported" };
  return isDocumentName(name)
    ? { ok: true, mediaType }
    : { ok: false, code: "document_name_invalid" };
}

/** Whether a file of `size` bytes is past a document's `bytes`, checked before a byte is read. */
export const isTooLarge = (size: number, bytes: number): boolean => size > bytes;

/**
 * A document's text as a Draft keeps it, or null when none is left (a scan has no text layer, and
 * nothing does OCR). U+0000 goes, as from a page (Postgres takes none in a text), another control
 * character but a tab or a line break becomes a space and a lone surrogate U+FFFD; then the cut at
 * 50,000 characters, never inside a character (`truncated`).
 */
export function documentText(raw: string): Pick<DraftDocument, "status" | "text"> | null {
  const text = raw
    .replaceAll("\u0000", "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(LONE_SURROGATE, "�");
  if (text.trim() === "") return null;
  if (text.length <= DOCUMENT_LIMITS.text) return { status: "read", text };
  // Never half of a surrogate pair at the cut.
  const high = /[\uD800-\uDBFF]/.test(text[DOCUMENT_LIMITS.text - 1] ?? "");
  return { status: "truncated", text: text.slice(0, DOCUMENT_LIMITS.text - (high ? 1 : 0)) };
}

/**
 * The document of the file `name` from its `bytes`: a PDF's text through unpdf (which `unpdf` loads),
 * its pages merged, any other file's as UTF-8; or the code that refuses it. PDF.js gets the bytes as
 * `data`, never a URL, and takes the array over, so `bytes` must be the caller's own copy.
 */
export async function documentFromBytes(
  name: string,
  mediaType: DocumentType,
  bytes: Uint8Array,
  unpdf: () => Promise<Unpdf>,
): Promise<DocumentResult> {
  let raw: string;
  try {
    raw =
      mediaType === DOCUMENT_TYPES[".pdf"]
        ? await pdfText(await unpdf(), bytes)
        : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    // PDF.js's PasswordException: an encrypted PDF. Else a damaged, cut or empty PDF
    // (InvalidPDFException), unpdf that did not load, or text that is not UTF-8.
    const kind = (error as { name?: unknown } | null)?.name;
    return {
      ok: false,
      code: kind === "PasswordException" ? "document_encrypted" : "document_unreadable",
    };
  }
  const kept = documentText(raw);
  if (kept === null) return { ok: false, code: "document_no_text" };
  return { ok: true, document: { name, mediaType, ...kept } };
}

/** A PDF's text, its pages merged (unpdf's extractText); the loading task destroyed after. */
async function pdfText(unpdf: Unpdf, bytes: Uint8Array): Promise<string> {
  const pdf = await unpdf.getDocumentProxy(bytes, { ...PDF_OPTIONS });
  try {
    return (await unpdf.extractText(pdf, { mergePages: true })).text;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

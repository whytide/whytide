// The documents of `pnpm knowledge:draft --file` (README "The documents"), read in the script's own
// process before anything is written: at most five files, each a .pdf, .txt or .md of at most 10 MB,
// a PDF's text through unpdf (PDF.js with PDF_OPTIONS: nothing fetched, nothing printed), a text
// file's as UTF-8, the text cut at 50,000 characters, never inside a character. Only this file
// imports unpdf, and only the script imports it: PDF.js adds globals on its first call, and the api
// and the worker never load it. Nothing here logs.
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { type DraftDocument, isDocumentName } from "../domain/documents.ts";
import { DOCUMENT_LIMITS, MEDIA_TYPES, PDF_OPTIONS } from "./constants.ts";

/** The documents read, in the order given, or the code that stops the script and the file it names. */
export type DocumentsRead =
  | { readonly ok: true; readonly documents: DraftDocument[] }
  | { readonly ok: false; readonly code: string; readonly file: string };
type Read =
  | { readonly ok: true; readonly document: DraftDocument }
  | { readonly ok: false; readonly code: string; readonly file: string };

/** Reads `files`, paths from `cwd`, the folder the script was started in; the first refusal stops. */
export async function readDocuments(files: readonly string[], cwd: string): Promise<DocumentsRead> {
  const extra = files[DOCUMENT_LIMITS.files];
  if (extra !== undefined) return { ok: false, code: "documents_too_many", file: extra };
  const documents: DraftDocument[] = [];
  for (const file of files) {
    const read = await readDocument(resolve(cwd, file), file);
    if (!read.ok) return read;
    if (documents.some(({ name }) => name === read.document.name)) {
      return { ok: false, code: "document_name_repeated", file };
    }
    documents.push(read.document);
  }
  return { ok: true, documents };
}

async function readDocument(path: string, file: string): Promise<Read> {
  const refuse = (code: string) => ({ ok: false, code, file }) as const;
  const name = basename(path);
  const mediaType = MEDIA_TYPES[extname(name).toLowerCase()];
  if (mediaType === undefined) return refuse("document_type_unsupported");
  if (!isDocumentName(name)) return refuse("document_name_invalid");
  const found = await stat(path).catch(() => null);
  if (found === null || !found.isFile()) return refuse("document_not_found");
  if (found.size > DOCUMENT_LIMITS.bytes) return refuse("document_too_large");
  let text: string;
  try {
    const bytes = await readFile(path);
    const pdf = mediaType === MEDIA_TYPES[".pdf"];
    text = pdf ? await pdfText(bytes) : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    // PDF.js's PasswordException: an encrypted PDF. Else a damaged, cut or empty PDF
    // (InvalidPDFException), a file that cannot be read, or text that is not UTF-8.
    const kind = (error as { name?: unknown } | null)?.name;
    return refuse(kind === "PasswordException" ? "document_encrypted" : "document_unreadable");
  }
  // Postgres takes no U+0000 in a text: it goes, as from a page (domain/pages/html.ts), before the
  // cut and the hash.
  text = text.replaceAll("\u0000", "");
  // A scan has no text layer, and the script does no OCR.
  if (text.trim() === "") return refuse("document_no_text");
  const cut = text.length > DOCUMENT_LIMITS.text;
  // Never half of a surrogate pair at the cut.
  const high = cut && /[\uD800-\uDBFF]/.test(text[DOCUMENT_LIMITS.text - 1] ?? "");
  const kept = cut ? text.slice(0, DOCUMENT_LIMITS.text - (high ? 1 : 0)) : text;
  return {
    ok: true,
    document: { name, mediaType, status: cut ? "truncated" : "read", text: kept },
  };
}

/** A PDF's text, its pages merged (unpdf's extractText), from a copy of `bytes` PDF.js takes over. */
async function pdfText(bytes: Buffer): Promise<string> {
  // PDF.js refuses a Buffer, and empties the array it is given.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { ...PDF_OPTIONS });
  try {
    return (await extractText(pdf, { mergePages: true })).text;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

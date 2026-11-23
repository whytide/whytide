// The documents of `pnpm knowledge:draft --file` (README "The documents"), read in the script's own
// process before anything is written: at most ONBOARDING_MAX_FILES files, each a .pdf, .txt or .md
// of at most ONBOARDING_MAX_FILE_BYTES (five and 10 MB unset, README "Settings"), a PDF's text
// through unpdf (PDF.js with PDF_OPTIONS: nothing fetched, nothing printed), a text file's as UTF-8,
// the text cut at 50,000 characters, never inside a character. The rules are domain/documents.ts's,
// which the Company screen reads files by too. Only this file and the screen import unpdf, and only
// the script imports this one: PDF.js adds globals on its first call, and the api and the worker
// never load it. Nothing here logs.
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import {
  type DocumentRefusal,
  type DraftDocument,
  documentFromBytes,
  documentKind,
  isTooLarge,
} from "../domain/documents.ts";
import { settings } from "../settings.ts";

/** The documents read, in the order given, or the code that stops the script and the file it names. */
export type DocumentsRead =
  | { readonly ok: true; readonly documents: DraftDocument[] }
  | { readonly ok: false; readonly code: DocumentRefusal; readonly file: string };
type Read =
  | { readonly ok: true; readonly document: DraftDocument }
  | { readonly ok: false; readonly code: DocumentRefusal; readonly file: string };

const UNPDF = async () => ({ extractText, getDocumentProxy });

/** Reads `files`, paths from `cwd`, the folder the script was started in; the first refusal stops. */
export async function readDocuments(files: readonly string[], cwd: string): Promise<DocumentsRead> {
  const extra = files[settings.ONBOARDING_MAX_FILES];
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
  const refuse = (code: DocumentRefusal) => ({ ok: false, code, file }) as const;
  const name = basename(path);
  const kind = documentKind(name);
  if (!kind.ok) return refuse(kind.code);
  const found = await stat(path).catch(() => null);
  if (found === null || !found.isFile()) return refuse("document_not_found");
  if (isTooLarge(found.size, settings.ONBOARDING_MAX_FILE_BYTES))
    return refuse("document_too_large");
  // PDF.js refuses a Buffer, and empties the array it is given: a copy.
  const bytes = await readFile(path).then(
    (read) => new Uint8Array(read),
    () => null,
  );
  if (bytes === null) return refuse("document_unreadable");
  const read = await documentFromBytes(name, kind.mediaType, bytes, UNPDF);
  return read.ok ? read : refuse(read.code);
}

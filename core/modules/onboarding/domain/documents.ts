// The company's documents a Draft reads after the website's pages (README "The documents"): what the
// script hands requestDraft, and a document's source in a draft, `document:<name>`, which the gates
// check like a page's address and the screen shows as the name, never as a link. Plain TypeScript, no
// import from Node: the screen imports it.
import { DOCUMENT_NAME, DOCUMENT_SOURCE } from "./constants.ts";

/** truncated: the document's text was cut at 50,000 characters. */
export type DocumentStatus = "read" | "truncated";
/** A document the script read: its file's base name, its media type, its status and its text. */
export type DraftDocument = {
  readonly name: string;
  readonly mediaType: string;
  readonly status: DocumentStatus;
  readonly text: string;
};
/** A document as the script prints it: its name and its status, never its text. */
export type DocumentRead = { readonly name: string; readonly status: DocumentStatus };

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

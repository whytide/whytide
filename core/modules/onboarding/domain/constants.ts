// The fixed values of the company's documents (README "The documents"), beside the code that reads
// them. No import: the screen reads them too.

/** A drafted value's source when it comes from a document: `document:<name>`, never a web address. */
export const DOCUMENT_SOURCE = "document:";
/** A document's name: its file's base name, 1 to 255 characters, no control or format character. */
export const DOCUMENT_NAME = /^[^\p{C}/\\]{1,255}$/u;

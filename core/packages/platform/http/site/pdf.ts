// A PDF file's text for the site reader (README "The site reader"; gamma-wr-020): `unpdf` with
// PDF_OPTIONS, loaded by a dynamic import on the first PDF only, because PDF.js adds globals on its
// first call (README "The site reader": DOMMatrix, pdfjsWorker, pdfjsLib, _pdfjsTestingUtils and a
// Math.sumPrecise): the api and the worker that never read a PDF never get them. The file is
// untrusted: its pages are counted before any text is taken, the whole parse has a deadline, and
// whatever goes wrong answers null, never an error: nothing here carries the file's text.
import { CONTROL_CHARACTERS, FETCH_LIMITS, LONE_SURROGATE, PDF_OPTIONS } from "./constants.ts";

/** A PDF's title (when the file has one) and its text, pages merged, cleaned and cut. */
export type PdfText = {
  readonly title: string;
  readonly text: string;
  /** Whether the text was cut at FETCH_LIMITS.text. */
  readonly cut: boolean;
};

/** `text` without U+0000, with another control character but a tab and a line break a space. */
const clean = (text: string): string =>
  text.replaceAll("\u0000", "").replace(CONTROL_CHARACTERS, " ").replace(LONE_SURROGATE, "�");

/**
 * The text of the PDF in `bytes` (the caller's own copy: PDF.js takes the array over) within
 * `timeoutMs`, or null: past FETCH_LIMITS.pdfPages, with no text in it (a scan: no OCR), encrypted,
 * damaged, unparsed in time, or unpdf not loading.
 */
export async function readPdf(bytes: Uint8Array, timeoutMs: number): Promise<PdfText | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, Math.max(1, timeoutMs), null);
  });
  const work = parse(bytes).catch(() => null);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function parse(bytes: Uint8Array): Promise<PdfText | null> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes, { ...PDF_OPTIONS });
  try {
    if (pdf.numPages > FETCH_LIMITS.pdfPages) return null;
    const raw = (await extractText(pdf, { mergePages: true })).text;
    const text = clean(raw);
    if (text.trim() === "") return null;
    const cut = text.length > FETCH_LIMITS.text;
    // Never half of a surrogate pair at the cut.
    const high = cut && /[\uD800-\uDBFF]/.test(text[FETCH_LIMITS.text - 1] ?? "");
    const kept = cut ? text.slice(0, FETCH_LIMITS.text - (high ? 1 : 0)) : text;
    const given = (await getMeta(pdf).catch(() => null))?.info?.Title;
    const title = typeof given === "string" ? clean(given).replace(/\s+/g, " ").trim() : "";
    return { title: title.slice(0, FETCH_LIMITS.title), text: kept, cut };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

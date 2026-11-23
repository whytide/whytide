// PDF files for tests/site/read-page.test.ts, built by hand with no PDF library: one page per
// content stream, Helvetica (a standard font, not embedded) as /F1, offsets counted in bytes. The
// text is made up.

const TEXT = (line: string) => `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;

/** A PDF with one page per content stream; `title` goes in its Info dictionary when given. */
export function pdf(contents: readonly string[], title?: string): Buffer {
  const kids = contents.map((_, at) => `${5 + at * 2} 0 R`).join(" ");
  const resources = "<< /Font << /F1 3 0 R >> >>";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${contents.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    title === undefined ? "<< >>" : `<< /Title (${title}) >>`,
    ...contents.flatMap((content, at) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${6 + at * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    ]),
  ];
  let file = "%PDF-1.4\n";
  const offsets = objects.map((object, at) => {
    const offset = Buffer.byteLength(file, "latin1");
    file += `${at + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(file, "latin1");
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`);
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries.join("")}`;
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file, "latin1");
}

/** A PDF with the given lines of text, one per page, and an optional title. */
export const textPdf = (lines: readonly string[], title?: string): Buffer =>
  pdf(lines.map(TEXT), title);

/** A page with a shape and no text layer, as a scanned page has. */
export const scanPdf = (): Buffer => pdf(["0.2 0.2 0.2 rg 72 72 468 648 re f"]);

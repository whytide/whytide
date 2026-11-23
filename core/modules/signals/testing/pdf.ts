// A PDF file for the research run's tests (README.md "Testing"), built by hand with no PDF library:
// one page per line of text, Helvetica (a standard font, not embedded), offsets counted in bytes. The
// text is made up by the test.

/** A PDF with the given lines of text, one per page. */
export function textPdf(lines: readonly string[]): Buffer {
  const contents = lines.map((line) => `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`);
  const kids = contents.map((_, at) => `${4 + at * 2} 0 R`).join(" ");
  const resources = "<< /Font << /F1 3 0 R >> >>";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${contents.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...contents.flatMap((content, at) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${5 + at * 2} 0 R >>`,
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
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file, "latin1");
}

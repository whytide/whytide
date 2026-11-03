// Writes the PDF fixtures of tests/documents.test.ts beside this file, by hand, with no PDF library:
// deck.pdf, two pages of text in Helvetica (a standard font, not embedded); scan.pdf, a page with a
// shape and no text layer, as a scanned page has; locked.pdf, deck.pdf behind a user password that
// is not empty (an /Encrypt dictionary whose keys match no password). Synthetic text only.
//   node tests/fixtures/documents/make-pdf.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** A PDF with one page per content stream, each page with Helvetica as /F1; offsets counted in bytes. */
function pdf(contents: readonly string[], locked = false): Buffer {
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
    ...(locked
      ? [`<< /Filter /Standard /V 1 /R 2 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> /P -44 >>`]
      : []),
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
  const id = `<${"0f".repeat(16)}>`;
  const encrypt = locked ? ` /Encrypt ${objects.length} 0 R /ID [${id} ${id}]` : "";
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypt} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file, "latin1");
}

const here = import.meta.dirname;
const deck = [
  "BT /F1 18 Tf 72 720 Td (Corvid Freight) Tj 0 -28 Td /F1 12 Tf (Same-day parcels for small shops.) Tj ET",
  "BT /F1 12 Tf 72 720 Td (Trusted by 300 shops in the city.) Tj ET",
];
writeFileSync(join(here, "deck.pdf"), pdf(deck));
writeFileSync(join(here, "scan.pdf"), pdf(["0.2 0.2 0.2 rg 72 72 468 648 re f"]));
writeFileSync(join(here, "locked.pdf"), pdf(deck, true));

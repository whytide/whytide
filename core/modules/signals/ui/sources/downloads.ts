// The CSV files the sources import offers (README.md "Importing sources"; sources-csv-import), built in
// the browser as data: URLs that a link saves: the sample, one made-up row per kind that checks clean;
// and the rows not imported, each row's number, code and columns, never a cell of the file.

/** The sample's name in the browser's downloads. */
export const SAMPLE_FILE = "sources-sample.csv";

/** The lines as a CSV file's data: URL. */
const href = (lines: readonly string[]) =>
  `data:text/csv;charset=utf-8,${encodeURIComponent(`${lines.join("\n")}\n`)}`;

export const SAMPLE_HREF = href([
  "kind,url,name,phrase,roles,label",
  "post,https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000,,,,Launch post",
  "creator,https://www.linkedin.com/in/example-creator,,,,",
  "company,https://www.linkedin.com/company/example-competitor,Example Competitor,,,",
  "topic,,,revenue operations,author;commenter,RevOps topic",
]);

/** A row not imported, as the routes answer it. */
export type RowError = { row: number; code: string; columns: string[] };

/** The rows not imported as a file named after `fileName`: `row,code,columns`, one line each. */
export function errorRows(fileName: string, errors: readonly RowError[]) {
  const file = `${fileName.replace(/\.csv$/i, "")}-errors.csv`;
  const lines = errors.map(({ row, code, columns }) => `${row},${code},${columns.join(";")}`);
  return { file, href: href(["row,code,columns", ...lines]) };
}

// The CSV files the import screen offers (README.md "The screen"), built in the browser as data:
// URLs that a link saves: the sample, the upload's columns with three made-up rows that validate
// clean; and a report's error rows, each row's number and code, never a cell of the file.
import type { ImportJobResponse } from "../../schemas/imports.ts";

/** The sample's name in the browser's downloads. */
export const SAMPLE_FILE = "import-sample.csv";

/** The lines as a CSV file's data: URL. */
const href = (lines: readonly string[]) =>
  `data:text/csv;charset=utf-8,${encodeURIComponent(`${lines.join("\n")}\n`)}`;

export const SAMPLE_HREF = href([
  "linkedin_url,name,company",
  "https://www.linkedin.com/in/example-person-1,Example Person 1,Example Company",
  "https://www.linkedin.com/in/example-person-2,Example Person 2,Example Company",
  "https://www.linkedin.com/in/example-person-3,Example Person 3,Example Company",
]);

/** The report's error rows, the first 100 as the report keeps them: `row,code`, one line each. */
export function errorRows(job: ImportJobResponse) {
  const file = `${job.fileName.replace(/\.csv$/i, "")}-errors.csv`;
  return { file, href: href(["row,code", ...job.errors.map(({ row, code }) => `${row},${code}`)]) };
}

// The row validator (domain/rows.ts): contacts' profile rule, or why a cell is no profile, then a
// duplicate in the file, then an erased person, as the report counts and names them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkUrl, REPORT_ERRORS, RowCheck } from "../domain/rows.ts";

test("a cell is the profile URL by contacts' rule, else url_not_linkedin or url_invalid; nothing is evaluated", () => {
  const profile = { url: "https://linkedin.com/in/example-person-1" };
  for (const cell of [
    " https://www.LinkedIn.com/in/Example-Person-1/?trk=x#top ",
    "http://linkedin.com/in/example-person-1",
    "linkedin.com/in/example-person-1",
    "www.linkedin.com/in/Example-Person-1/",
  ]) {
    assert.deepEqual(checkUrl(cell), profile, cell);
  }
  for (const cell of [
    "",
    "example-person-1",
    "example.com/in/example-person-1",
    "=SUM(A1:A2)",
    "ftp://linkedin.com/in/x",
    "https://",
  ]) {
    assert.deepEqual(checkUrl(cell), { code: "url_invalid" }, cell);
  }
  for (const cell of [
    "https://example.com/in/example-person-1",
    "https://www.linkedin.com/company/example",
    "https://linkedin.com.example.com/in/x",
    "https://www.linkedin.com/in/",
    "https://www.linkedin.com/in/example-person-1//",
    "https://uk.linkedin.com/in/example-person-1",
    "https://m.linkedin.com/in/example-person-1",
  ]) {
    assert.deepEqual(checkUrl(cell), { code: "url_not_linkedin" }, cell);
  }
});

test("the report: counts, a later duplicate, erased rows last, the first 100 errors in row order", () => {
  const check = new RowCheck();
  check.add(2, "https://www.linkedin.com/in/example-person-1");
  check.add(3, "not a url");
  check.add(4, "https://linkedin.com/in/EXAMPLE-PERSON-1/");
  check.add(5, "https://www.linkedin.com/in/example-person-2");
  const [, second] = check.urls();
  assert.equal(check.urls().length, 2);
  assert.deepEqual(check.report(new Set([second ?? ""])), {
    rowCount: 4,
    validCount: 1,
    errorCount: 3,
    errors: [
      { row: 3, code: "url_invalid" },
      { row: 4, code: "duplicate_in_file" },
      { row: 5, code: "person_erased" },
    ],
  });

  const many = new RowCheck();
  for (let row = 2; row < 2 + 150; row += 1) many.add(row, "x");
  const report = many.report();
  assert.equal(report.errorCount, 150);
  assert.equal(report.errors.length, REPORT_ERRORS);
  assert.deepEqual(report.errors.at(-1), { row: 101, code: "url_invalid" });
});

// The run's arithmetic (domain/import/chunks.ts): the chunker, and the counts that put every data
// row in one bucket, a chunk's added to the chunks' before it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHUNK_SIZE, chunk, outcomeOf, tally } from "../domain/import/chunks.ts";
import { RowCheck } from "../domain/rows.ts";

test("the chunker keeps the order, 500 rows a chunk, the last one shorter, none for none", () => {
  const rows = Array.from({ length: 1_201 }, (_, i) => i);
  const chunks = chunk(rows);
  assert.equal(CHUNK_SIZE, 500);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [500, 500, 201],
  );
  assert.deepEqual(chunks.flat(), rows);
  assert.equal(chunk(rows.slice(0, 1_000)).length, 2);
  assert.deepEqual(chunk([]), []);
  assert.throws(() => chunk(rows, 0), RangeError);
});

test("the counts: the file's skips, then each chunk's rows added to the chunks' before", () => {
  const check = new RowCheck();
  const cells = [
    "https://linkedin.com/in/a",
    "not a url",
    "https://example.com",
    "linkedin.com/in/A",
  ];
  const codes = cells.flatMap((cell, i) => {
    const checked = check.add(i + 2, cell);
    return "code" in checked ? [checked.code] : [];
  });
  assert.deepEqual(codes, ["url_invalid", "url_not_linkedin", "duplicate_in_file"]);
  const file = tally([...codes.map(outcomeOf), outcomeOf("person_erased")]);
  assert.deepEqual(file, {
    created: 0,
    updated: 0,
    skippedDuplicate: 1,
    skippedErased: 1,
    errors: 2,
  });
  const first = tally(["created", "created", "updated", "errors"], file);
  const second = tally(["skippedErased", "created"], first);
  assert.deepEqual(second, {
    created: 3,
    updated: 1,
    skippedDuplicate: 1,
    skippedErased: 2,
    errors: 3,
  });
  assert.equal(file.created, 0, "a tally never changes the counts it starts from");
});

// The stream reader's limits and checks (domain/csv.ts): it stops pulling the file at the first byte
// or row past a limit, refuses what is not UTF-8 CSV text, and gives every cell as a string.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { isAppError } from "@whytide/platform";
import { type CsvLimits, type CsvRow, readCsv } from "../domain/csv.ts";

const LIMITS: CsvLimits = { maxBytes: 1_000_000, maxRows: 100 };

/** The rows the reader gives for the chunks, or the code it throws. */
async function read(chunks: Iterable<Buffer | string> | AsyncIterable<string>, limits = LIMITS) {
  const rows: CsvRow[] = [];
  async function* file() {
    for await (const chunk of chunks) yield Buffer.from(chunk);
  }
  try {
    await readCsv(file(), limits, (row) => rows.push(row));
    return rows;
  } catch (error) {
    assert.ok(isAppError(error), String(error));
    return error.code;
  }
}

/** A header and then rows, one chunk each, served slowly, counting the chunks pulled. */
function served(rows: number) {
  const pulled = { chunks: 0 };
  async function* chunks() {
    for (let n = 0; n <= rows; n += 1) {
      await tick();
      pulled.chunks += 1;
      yield n === 0
        ? "linkedin_url,name\n"
        : `https://www.linkedin.com/in/example-person-${n},E ${n}\n`;
    }
  }
  return { pulled, chunks: chunks() };
}

test("served slowly, the reader stops pulling the file at the row, or the byte, past the limit", async () => {
  const rows = served(10_000);
  assert.equal(await read(rows.chunks), "import_too_many_rows");
  // The header and the 101st data row, and the few chunks the source has asked for meanwhile.
  assert.ok(rows.pulled.chunks <= 102 + 16, `${rows.pulled.chunks} of 10,001 chunks pulled`);

  const bytes = served(10_000);
  assert.equal(await read(bytes.chunks, { maxBytes: 4_000, maxRows: 10_000 }), "import_too_large");
  assert.ok(bytes.pulled.chunks <= 80 + 16, `${bytes.pulled.chunks} of 10,001 chunks pulled`);
  const atLimit = await read(["linkedin_url\n", "x".repeat(10)], { maxBytes: 23, maxRows: 1 });
  assert.equal(Array.isArray(atLimit) && atLimit.length, 1);
});

test("only UTF-8 CSV text with a linkedin_url column is read, every cell as a string", async () => {
  assert.equal(await read(["PK\x03\x04\x14\x00rest"]), "import_unsupported_type");
  assert.equal(await read(["P", "K\x03\x04 split over chunks"]), "import_unsupported_type");
  assert.equal(await read(["linkedin_url\nhttps://x\u0000\n"]), "import_unsupported_type");
  assert.equal(await read([Buffer.from([0x6c, 0x0a, 0xff, 0xfe])]), "import_bad_encoding");
  assert.equal(await read(['linkedin_url\n"unclosed\n']), "import_unsupported_type");
  assert.equal(await read(["linkedin_url,name\na,b,c\n"]), "import_unsupported_type");
  assert.equal(await read(["name,company\nExample,Example Ltd\n"]), "import_missing_column");
  assert.equal(await read([]), "import_missing_column");

  const text = [
    "﻿Company, LinkedIn_URL ,Name,notes\r\n",
    'Example Ltd,https://www.linkedin.com/in/example-person-1,"=SUM(1,2)",x\n',
    ",,,\n",
    '"Two\nlines",+1 555,@cmd,-2\r',
    "\n",
  ];
  assert.deepEqual(await read(text), [
    {
      row: 2,
      linkedinUrl: "https://www.linkedin.com/in/example-person-1",
      name: "=SUM(1,2)",
      company: "Example Ltd",
    },
    { row: 4, linkedinUrl: "+1 555", name: "@cmd", company: "Two\nlines" },
  ]);
});

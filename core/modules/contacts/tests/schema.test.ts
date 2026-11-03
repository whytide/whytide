// The columns of contacts' tables (alpha-p5-010; docs/rules/security.md §2, data model §2.6), read
// from the information schema of this file's migrated schema: no contact detail, picture, pronoun,
// gender, age or special category; every column classed in domain/fields.ts; every person-data
// column marked `/// pii: <class>` in contacts.prisma with the same class, and its key in the
// platform's PII registry, which the log redaction reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { piiKeys } from "@whytide/platform";
import { fields } from "../domain/fields.ts";

const db = withTestDb();
const SCHEMA = new URL("../../../packages/db/prisma/schema/contacts.prisma", import.meta.url);
// A column whose name has one of these words: contact details, a picture, pronouns, gender, age, and
// the special categories (GDPR art. 9 and 10).
const FORBIDDEN =
  /(^|_)(e?mails?|phones?|mobile|fax|photos?|picture|avatar|image|pronouns?|gender|sex|age|birth\w*|dob|relig\w*|belief|health|disab\w*|politic\w*|ethnic\w*|race|orientation|union|biometric|genetic|criminal)(_|$)/;
const camel = (column: string) => column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** `{ table: { column: class } }` from the `/// pii: <class>` line right above a column. */
function markers(): Record<string, Record<string, string>> {
  const found: Record<string, Record<string, string>> = {};
  for (const [, body = ""] of readFileSync(SCHEMA, "utf8").matchAll(
    /^model \w+ \{\n([\s\S]*?)^\}/gm,
  )) {
    const columns: Record<string, string> = {};
    let pii: string | undefined;
    for (const line of body.split("\n")) {
      const marker = /^\s*\/\/\/\s*pii:\s*(\w+)/.exec(line)?.[1];
      if (marker || /^\s*\/\//.test(line)) {
        pii = marker ?? pii;
        continue;
      }
      const field = /^\s*(\w+)\s+\S/.exec(line)?.[1];
      if (field && pii) columns[/@map\("(\w+)"\)/.exec(line)?.[1] ?? field] = pii;
      pii = undefined;
    }
    found[/@@map\("(\w+)"\)/.exec(body)?.[1] ?? ""] = columns;
  }
  return found;
}

test("persons has no email, phone, photo, pronoun, gender, age or special-category column; every column is in domain/fields.ts, and every person-data one carries its /// pii marker and its log-redaction key", async () => {
  const words = [
    "email",
    "phone_number",
    "photo_url",
    "pronouns",
    "gender",
    "age",
    "date_of_birth",
  ];
  assert.ok(words.every((column) => FORBIDDEN.test(column)) && !FORBIDDEN.test("headline"));
  const tables = Object.keys(fields);
  const rows = await asRole("owner").$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = ${db.schema} AND table_name = ANY(${tables})`;
  const marked = markers();
  for (const [table, classes] of Object.entries(fields)) {
    const columns = rows.filter((row) => row.table_name === table).map((row) => row.column_name);
    assert.deepEqual(columns.sort(), Object.keys(classes).sort(), `${table}: domain/fields.ts`);
    for (const column of columns) assert.ok(!FORBIDDEN.test(column), `${table}.${column}`);
    const personData = Object.entries(classes).filter(([, pii]) => pii !== "none");
    assert.deepEqual(marked[table], Object.fromEntries(personData), `${table}: /// pii markers`);
    for (const key of personData.flatMap(([column]) => [column, camel(column)])) {
      assert.ok(piiKeys.includes(key), `${table}: ${key} is in the platform's piiKeys`);
    }
  }
});

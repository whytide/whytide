// Unit test of the ICU validator wrapper: what the parser accepts, what fails, and the stray brace
// the parser lets through (alpha-p1-080).
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatIcu, validateIcu } from "../i18n/icu.ts";

test("validateIcu accepts plain text, placeholders, plurals, selects and escaped braces", () => {
  for (const ok of [
    "Things",
    "Hello {name}",
    "{count, plural, one {# thing} other {# things}}",
    "{gender, select, female {her} male {his} other {their}} list",
    "Use '{' and '}' as text",
    "It''s {count, number} o''clock",
    "{when, date, medium}",
  ]) {
    assert.equal(validateIcu(ok), undefined, ok);
  }
});

test("validateIcu names the fault: an unclosed brace, a stray brace, a plural without other, an unknown type", () => {
  assert.match(validateIcu("Hello {name") ?? "", /\{ without its \}/);
  assert.match(validateIcu("Hello name}") ?? "", /\} without its \{/);
  assert.match(validateIcu("{count, plural, one {# thing}}") ?? "", /other/);
  assert.match(validateIcu("{x, badtype}") ?? "", /argument type/i);
  assert.notEqual(validateIcu("{}"), undefined);
});

test("formatIcu formats plurals and placeholders for the locale", () => {
  const plural = "{count, plural, one {# thing} other {# things}}";
  assert.equal(formatIcu(plural, { count: 1 }, "en"), "1 thing");
  assert.equal(formatIcu(plural, { count: 2 }, "en"), "2 things");
  assert.equal(formatIcu("{n, number}", { n: 1234.5 }, "de-DE"), "1.234,5");
});

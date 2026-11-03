// The processing's rules (alpha-p8-030; README.md "Processing"): the own-employee rule, the dedupe key
// and the excerpt's cut.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeKeyOf, EXCERPT_LENGTH, excerptOf, ownCompanyRule } from "../domain/process/rules.ts";

test("the own-employee rule matches the domain or the name as whole words, in any case", () => {
  const own = ownCompanyRule({ domain: "acme.io", name: "Acme Labs" });
  const matched = [
    "Head of sales at ACME LABS",
    "Acme   Labs GmbH",
    "Founder, acme.io",
    "https://www.acme.io/",
  ];
  for (const text of matched) assert.equal(own(text), true, text);
  const missed = [
    "Acme Laboratories",
    "Ex-Acme Labsy",
    "notacme.io",
    "acme.ios",
    "",
    null,
    undefined,
  ];
  for (const text of missed) assert.equal(own(text), false, String(text));
  assert.equal(ownCompanyRule({ domain: null, name: "A" })("A team"), false);
  assert.equal(ownCompanyRule({ domain: null, name: null })("Acme"), false);
});

test("the dedupe key is one per kind, engager, post and reaction", () => {
  const like = {
    kind: "post_engagement",
    actor: "member-1",
    objectUrl: "https://x/p/1",
    role: "like",
  };
  assert.match(dedupeKeyOf(like), /^[0-9a-f]{64}$/);
  assert.equal(dedupeKeyOf({ ...like }), dedupeKeyOf(like));
  const others = [{ actor: "member-2" }, { objectUrl: "https://x/p/2" }, { role: "comment" }];
  for (const other of others)
    assert.notEqual(dedupeKeyOf({ ...like, ...other }), dedupeKeyOf(like));
});

test("the excerpt is the first 500 characters of the person's words, never half a character", () => {
  assert.equal(excerptOf("  Useful, thanks  "), "Useful, thanks");
  assert.equal(excerptOf("a".repeat(600)), "a".repeat(EXCERPT_LENGTH));
  const emoji = excerptOf("😀".repeat(600));
  assert.deepEqual([Array.from(emoji ?? "").length, emoji?.length], [500, 1000]);
  for (const none of [null, undefined, "", "   "]) assert.equal(excerptOf(none), null);
});

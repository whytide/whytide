// Unit tests of ids (alpha-p1-030): ULIDs sort by creation time and stay monotonic inside one
// millisecond, a prefix is declared before use, and parseId rejects the wrong prefix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineIds, newId, parseId, registeredPrefixes } from "../ids/index.ts";
import { throwsCode } from "../testing/index.ts";

const ids = defineIds({ per: "person", wsp: "workspace" });

test("ids sort by creation time and parse back", () => {
  const before = Date.now();
  const made = Array.from({ length: 2000 }, () => newId(ids.person));
  const after = Date.now();
  assert.deepEqual([...made].sort(), made);
  assert.equal(new Set(made).size, made.length);
  const first = made[0];
  assert.ok(first);
  assert.match(first, /^per_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  const parsed = parseId(first, "per");
  assert.equal(parsed.prefix, "per");
  assert.ok(parsed.time.getTime() >= before && parsed.time.getTime() <= after);
});

test("parseId rejects the wrong prefix and a malformed id with invalid_id", () => {
  throwsCode(() => parseId(newId(ids.workspace), "per"), "invalid_id");
  throwsCode(() => parseId("per_not-a-ulid", "per"), "invalid_id");
  throwsCode(() => parseId(`per_${"I".repeat(26)}`, "per"), "invalid_id");
  throwsCode(() => parseId(`per_${"Z".repeat(26)}`, "per"), "invalid_id");
});

test("a prefix is declared before use, once, in lowercase", () => {
  throwsCode(() => newId("nope"), "unknown_prefix");
  throwsCode(() => defineIds({ Per: "person" }), "invalid_prefix");
  throwsCode(() => defineIds({ per: "lead" }), "duplicate_prefix");
  throwsCode(() => defineIds({ per: "person" }), "duplicate_prefix");
  assert.equal(registeredPrefixes().get("obx"), "outbox_entry");
});

// Unit tests of the retry backoff (alpha-p1-050): the waits double from the base and grow with every
// attempt until the cap, the jitter stays in the upper half, a constant random source repeats.
import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffMs } from "../outbox/index.ts";

test("the waits double from the base until the cap, with equal jitter, and grow with every attempt", () => {
  const low = (attempt: number) => backoffMs(attempt, { random: () => 0 });
  const high = (attempt: number) => backoffMs(attempt, { random: () => 0.999_999 });
  assert.deepEqual([1, 2, 3, 4, 5].map(low), [500, 1_000, 2_000, 4_000, 8_000]);
  assert.deepEqual([1, 2, 3].map(high), [999, 1_999, 3_999]);
  for (let attempt = 1; attempt < 10; attempt++) {
    assert.ok(
      high(attempt) < low(attempt + 1),
      `attempt ${attempt + 1} waits longer than ${attempt}`,
    );
  }
  assert.equal(low(11), 450_000, "attempt 11 is the first the cap of fifteen minutes holds");
  assert.equal(low(60), 450_000);
  assert.ok(high(60) < 900_000);
  assert.equal(low(0), 500, "below the first attempt counts as the first");
  assert.equal(backoffMs(3, { baseMs: 100, capMs: 250, random: () => 0.5 }), 187);
  for (let i = 0; i < 1_000; i++) {
    const wait = backoffMs(2);
    assert.ok(wait >= 1_000 && wait < 2_000, `${wait} is within the upper half`);
  }
});

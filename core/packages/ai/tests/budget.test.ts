// The budget estimator (README.md "The budget"): UTF-8 bytes over three, never below the LLM fake's
// count, so that a call the fake would count over budget is refused before it is made.
import assert from "node:assert/strict";
import { it } from "node:test";
import { estimateTokens } from "../run/budget.ts";

/** The fake's count (core/packages/providers/llm/fake): UTF-16 code units over four, rounded up. */
const fakeCount = (text: string) => Math.ceil(text.length / 4);

it("counts UTF-8 bytes over three, rounded up", () => {
  const cases = { "": 0, abc: 1, abcd: 2, é: 1, 日本語: 3, "😀": 2 };
  for (const [text, tokens] of Object.entries(cases)) assert.equal(estimateTokens(text), tokens);
});

it("never counts fewer tokens than the fake", () => {
  const samples = [
    "a",
    "Head of data",
    "x".repeat(1001),
    "Zürich, Köln",
    "東京の会社",
    "😀😀😀",
    "\ud800",
  ];
  for (const text of samples) assert.ok(estimateTokens(text) >= fakeCount(text), text);
});

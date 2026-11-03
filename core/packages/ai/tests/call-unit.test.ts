// The wrapper's two pure parts (README.md "Calling an agent"): the input hash and the retry decision.
import assert from "node:assert/strict";
import { it } from "node:test";
import { nextStep } from "../call/call-agent.ts";
import { canonicalJson, inputHash } from "../call/hash.ts";

it("hashes canonical JSON: the order of keys at any depth changes nothing, a value does", () => {
  const a = { profile: "p", evidence: [{ b: 1, a: [2, { d: 3, c: 4 }] }] };
  const b = { evidence: [{ a: [2, { c: 4, d: 3 }], b: 1 }], profile: "p" };
  assert.equal(canonicalJson(a), '{"evidence":[{"a":[2,{"c":4,"d":3}],"b":1}],"profile":"p"}');
  assert.equal(inputHash(a), inputHash(b));
  assert.match(inputHash(a), /^[0-9a-f]{64}$/);
  assert.notEqual(inputHash(a), inputHash({ ...a, profile: "q" }));
  assert.notEqual(inputHash({ evidence: [1, 2] }), inputHash({ evidence: [2, 1] }));
});

it("keeps a passing answer, retries a failing one once, then answers ai_failed", () => {
  assert.equal(nextStep({ ok: true }, 1), "ok");
  assert.equal(nextStep({ ok: false }, 1), "retry");
  assert.equal(nextStep({ ok: false }, 2), "ai_failed");
  assert.equal(nextStep({ ok: true }, 2), "ok");
});

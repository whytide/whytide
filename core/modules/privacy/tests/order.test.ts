// The erasers' order (domain/erase/registry.ts), with no database: each runs before the erasers of
// the modules it depends on, ties by module name; a module twice, an unknown dependency and a cycle
// are eraser_order_invalid, naming the modules. The registered order is the one the script runs,
// but for the platform's step, which it runs first (domain/erase/erase.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { erasingModules, FIRST } from "../domain/erase/erasers.ts";
import { type Eraser, orderErasers, registeredErasers } from "../domain/erase/registry.ts";

const eraser = (module: string, dependsOn: string[] = []): Eraser => ({
  module,
  dependsOn,
  erase: async () => ({}),
});
const order = (erasers: Eraser[]) => orderErasers(erasers).map((e) => e.module);
const invalid = (reason: string, modules: string[]) => ({
  code: "eraser_order_invalid",
  details: { reason, modules },
});

test("an eraser runs before those of the modules it depends on; free ones by module name", () => {
  assert.deepEqual(order([]), []);
  assert.deepEqual(order([eraser("b"), eraser("a"), eraser("c")]), ["a", "b", "c"]);
  // c's rows name b's, b's name a's: c, b, a, whatever the registration order.
  const chain = [eraser("a"), eraser("b", ["a"]), eraser("c", ["b"])];
  assert.deepEqual(order(chain), ["c", "b", "a"]);
  assert.deepEqual(order([...chain].reverse()), ["c", "b", "a"]);
  // a waits for both of the modules that depend on it; d, free from the start, goes by its name.
  const shared = [eraser("a"), eraser("z", ["a"]), eraser("m", ["a"]), eraser("d")];
  assert.deepEqual(order(shared), ["d", "m", "z", "a"]);
});

test("a module twice, a dependency on a module without an eraser and a cycle are refused", () => {
  assert.throws(() => order([eraser("a"), eraser("b"), eraser("a")]), invalid("duplicate", ["a"]));
  assert.throws(() => order([eraser("a", ["x"])]), invalid("unknown_dependency", ["x"]));
  const cycle = [eraser("a", ["c"]), eraser("b", ["a"]), eraser("c", ["b"]), eraser("d")];
  assert.throws(() => order(cycle), invalid("cycle", ["a", "b", "c"]));
});

test("the registered erasers: drafts, snapshots, rated events and reply classifications before ai's records, the outbox before campaigns', contacts last; none before the platform's", () => {
  const registered = registeredErasers().map((e) => e.module);
  const free = ["approvals", "enrichment", "inbox", "linkedin", "messaging", "platform"];
  assert.deepEqual(registered, [...free, "campaigns", "qualification", "signals", "ai"]);
  assert.deepEqual(erasingModules(), [...registered, "contacts"]);
  // The modules whose rows name a decision record (gamma-p4-040 adds inbox's classifications).
  const naming = (module: string) =>
    registeredErasers().flatMap((e) => (e.dependsOn.includes(module) ? [e.module] : []));
  assert.deepEqual(naming("ai"), ["inbox", "messaging", "qualification", "signals"]);
  // The run puts the platform's step first: no module's rows may name the platform's.
  assert.deepEqual(naming(FIRST), []);
});

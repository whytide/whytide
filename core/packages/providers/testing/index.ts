// The contract harness (docs/architecture.md §9 rule 4): one suite per port, run against every
// adapter, the fake included, so that nothing outside the adapter depends on the vendor. An adapter's
// <port>/<adapter>/tests/contract.test.ts is one contractSuite() call. The suite is skipped, never
// failed, while a variable the adapter requires is empty: a missing secret is not a defect of the code.
import assert from "node:assert/strict";
import { before, describe, it, type TestContext } from "node:test";
import type { AdapterDefinition } from "../_pattern/adapter.ts";
import { isFake } from "../_pattern/fake.ts";
import { type AnyPort, bindPort, type PortInstance } from "../_pattern/port.ts";

/** The port's cases, by title; each gets the bound adapter and the test context. */
export type ContractCases<P extends AnyPort> = Readonly<
  Record<string, (adapter: PortInstance<P>, t: TestContext) => Promise<void> | void>
>;
/** What the suite reads of an adapter: a definition, or a stand-in that is not registered. */
export type ContractAdapter<P extends AnyPort> = Pick<
  AdapterDefinition<P>,
  "port" | "name" | "requires" | "create"
>;

export function contractSuite<P extends AnyPort>(
  port: P,
  adapter: ContractAdapter<P>,
  cases: ContractCases<P>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const title = `${port.name} contract: ${adapter.name}`;
  const missing = adapter.requires.filter((variable) => !env[variable]);
  if (missing.length) {
    // A plain describe with one skipped test: a skipped describe runs nothing and counts as skipped 0.
    describe(title, () => {
      it(`skipped: no credentials (${missing.join(", ")})`, { skip: true }, () => {});
    });
    return;
  }
  describe(title, () => {
    const methods = Object.keys(port.methods);
    let instance: PortInstance<P>;
    before(() => {
      instance = bindPort(port, adapter.create(), { adapter: adapter.name });
    });
    it(`exposes the port's methods: ${methods.join(", ")}`, () => {
      for (const method of methods) {
        assert.equal(typeof (instance as Record<string, unknown>)[method], "function", method);
      }
    });
    for (const [name, run] of Object.entries(cases)) {
      it(name, async (t) => {
        if (isFake(instance)) instance.reset();
        await run(instance, t);
      });
    }
  });
}

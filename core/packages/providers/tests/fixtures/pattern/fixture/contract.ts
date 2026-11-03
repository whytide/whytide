// The fixture port's contract (README.md "The contract suite"): what every adapter of it does, run
// by each adapter's tests/contract.test.ts, the fake included.
import assert from "node:assert/strict";
import { isAppError } from "@whytide/platform";
import type { ContractCases } from "../../../../testing/index.ts";
import type { fixturePort } from "./port.ts";

export const fixtureCases: ContractCases<typeof fixturePort> = {
  "greets by name": async (fixture) => {
    assert.deepEqual(await fixture.greet({ name: "Ada" }), { greeting: "hello Ada" });
  },
  "shouts on request": async (fixture) => {
    assert.deepEqual(await fixture.greet({ name: "Ada", shout: true }), { greeting: "HELLO ADA" });
  },
  "counts every greeting": async (fixture) => {
    const { greetings } = await fixture.count();
    await fixture.greet({ name: "Bao" });
    assert.deepEqual(await fixture.count(), { greetings: greetings + 1 });
  },
  "knows nobody: fixture_not_found": async (fixture) => {
    await assert.rejects(
      fixture.greet({ name: "nobody" }),
      (error: unknown) => isAppError(error) && error.code === "fixture_not_found",
    );
  },
};

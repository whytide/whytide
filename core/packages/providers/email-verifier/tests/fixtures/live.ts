// The live suite of an email-verifier adapter (../../README.md "The contract suite"), each adapter's
// tests/contract.test.ts: one check of the address the owner names in <PREFIX>_TEST_ADDRESS, one the
// owner controls. Unset: one skipped test, and nothing reaches the vendor; the adapter's own
// variables never do alone. Set, the suite still skips while a variable the adapter requires is
// empty (contractSuite), and emailVerifierCases refuses to start under APP_ENV=production. .env.local
// is not read: the variables come from the environment.
import { describe, it } from "node:test";
import type { AdapterDefinition } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import { emailVerifierCases } from "../../contract.ts";
import { emailVerifierPort } from "../../port.ts";

type Env = Readonly<Record<string, string | undefined>>;

export function liveSuite(
  adapter: AdapterDefinition<typeof emailVerifierPort>,
  prefix: string,
  env: Env = process.env,
): void {
  const address = env[`${prefix}_TEST_ADDRESS`];
  if (!address) {
    describe(`${emailVerifierPort.name} contract: ${adapter.name}`, () => {
      it(`skipped: no ${prefix}_TEST_ADDRESS (README.md "Variables")`, { skip: true }, () => {});
    });
    return;
  }
  const world = { live: true, address: () => address } as const;
  contractSuite(emailVerifierPort, adapter, emailVerifierCases(world), env);
}

// The live suite of an email-finder adapter (../../README.md "The contract suite"), each adapter's
// tests/contract.test.ts: one lookup of the person the owner names in <PREFIX>_TEST_FIRST_NAME,
// _TEST_LAST_NAME and _TEST_DOMAIN, all three set. Else one skipped test, and nothing reaches the
// vendor; the adapter's own variables never do alone. Set, the suite still skips while a variable
// the adapter requires is empty (contractSuite), and emailFinderCases refuses to start under
// APP_ENV=production. .env.local is not read: the variables come from the environment.
import { describe, it } from "node:test";
import type { AdapterDefinition } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import { emailFinderCases } from "../../contract.ts";
import { emailFinderPort, type FindEmailInput } from "../../port.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The owner's person as one lookup; undefined unless all three variables are set. */
export function livePerson(env: Env, prefix: string): FindEmailInput | undefined {
  const firstName = env[`${prefix}_TEST_FIRST_NAME`];
  const lastName = env[`${prefix}_TEST_LAST_NAME`];
  const companyDomain = env[`${prefix}_TEST_DOMAIN`];
  if (!firstName || !lastName || !companyDomain) return undefined;
  return { firstName, lastName, companyDomain };
}

export function liveSuite(
  adapter: AdapterDefinition<typeof emailFinderPort>,
  prefix: string,
  env: Env = process.env,
): void {
  const person = livePerson(env, prefix);
  if (person === undefined) {
    describe(`${emailFinderPort.name} contract: ${adapter.name}`, () => {
      const title = `skipped: no ${prefix}_TEST_FIRST_NAME, _LAST_NAME and _DOMAIN (README.md "Variables")`;
      it(title, { skip: true }, () => {});
    });
    return;
  }
  contractSuite(
    emailFinderPort,
    adapter,
    emailFinderCases({ live: true, person: () => person }),
    env,
  );
}

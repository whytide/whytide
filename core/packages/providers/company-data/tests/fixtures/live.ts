// The live suite of a company-data adapter (../../README.md "The contract suite"), each adapter's
// tests/contract.test.ts: one lookup of the company the owner names in <PREFIX>_TEST_NAME,
// _TEST_DOMAIN and _TEST_LINKEDIN_URL, whichever are set, together. None set: one skipped test, and
// nothing reaches the vendor; the adapter's own variables never do alone. Set, the suite still skips
// while a variable the adapter requires is empty (contractSuite), and companyDataCases refuses to
// start under APP_ENV=production. .env.local is not read: the variables come from the environment.
import { describe, it } from "node:test";
import type { AdapterDefinition } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import { companyDataCases } from "../../contract.ts";
import { type CompanyLookup, companyDataPort } from "../../port.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The owner's company as one lookup, from the variables set; undefined when none is. */
export function liveLookup(env: Env, prefix: string): CompanyLookup | undefined {
  const keys = {
    linkedinUrl: env[`${prefix}_TEST_LINKEDIN_URL`],
    domain: env[`${prefix}_TEST_DOMAIN`],
    name: env[`${prefix}_TEST_NAME`],
  };
  const set = Object.entries(keys).filter(([, value]) => value);
  return set.length === 0 ? undefined : (Object.fromEntries(set) as CompanyLookup);
}

/** The adapter's live suite, `hint` added to the owner's lookup (companies-house's GB). */
export function liveSuite(
  adapter: AdapterDefinition<typeof companyDataPort>,
  prefix: string,
  hint: Pick<CompanyLookup, "countryHint"> = {},
  env: Env = process.env,
): void {
  const lookup = liveLookup(env, prefix);
  if (lookup === undefined) {
    describe(`${companyDataPort.name} contract: ${adapter.name}`, () => {
      it(`skipped: no ${prefix}_TEST_* variable (README.md "Variables")`, { skip: true }, () => {});
    });
    return;
  }
  const world = { live: true, company: () => ({ ...lookup, ...hint }) } as const;
  contractSuite(companyDataPort, adapter, companyDataCases(world), env);
}

// The company-data port's contract (README.md "The contract suite"): what every adapter does, run by
// each adapter's tests/contract.test.ts in its world. A live world, the vendor's API with the owner's
// key, gets exactly one lookup, of the company it names, and every other case skips: a free plan's
// calls are few. The live suite refuses to start under APP_ENV=production. An offline world, the
// fake or an adapter's recorded answers served on 127.0.0.1, gets every case: the company found
// with its facts, an unknown one not_found, the inputs refused before any call, and each of the
// port's codes from the vendor's answer, for the next call only.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { isAppError, platformConfig } from "@whytide/platform";
import type { PortInstance } from "../_pattern/index.ts";
import type { ContractCases } from "../testing/index.ts";
import { NAME_MAX } from "./constants.ts";
import type { CompanyFacts, CompanyLookup, companyDataPort } from "./port.ts";

type CompanyData = PortInstance<typeof companyDataPort>;

/** The port's codes a vendor's answer maps to. */
export type CompanyDataFailure =
  | "company_data_rate_limited"
  | "company_data_allowance_spent"
  | "company_data_unauthorized"
  | "company_data_provider_error";

/** The seconds the contract's rate limit asks to wait, and the status of its provider error. */
export const RETRY_AFTER_SEC = 30;
export const PROVIDER_ERROR_STATUS = 503;

/** A company an offline world's adapter knows: its keys, and the facts the adapter answers. */
export type WorldCompany = { readonly lookup: CompanyLookup; readonly facts: CompanyFacts };
/** The vendor's API with the owner's key: the one company the owner may look up. */
export type LiveWorld = {
  readonly live: true;
  readonly company: () => CompanyLookup | Promise<CompanyLookup>;
};
/** The fake, or an adapter's recorded answers. Each hook runs inside its case, after a fake's reset. */
export type OfflineWorld = {
  readonly live: false;
  readonly company: () => WorldCompany | Promise<WorldCompany>;
  /** A company the adapter does not know. */
  readonly unknown: () => CompanyLookup | Promise<CompanyLookup>;
  /**
   * The vendor's next answer is one the port reads as `code`: the rate limit asks RETRY_AFTER_SEC,
   * the provider error answers PROVIDER_ERROR_STATUS.
   */
  readonly failNext: (code: CompanyDataFailure) => void;
  /** How many calls reached the vendor so far. */
  readonly calls: () => number;
};
export type CompanyDataWorld = LiveWorld | OfflineWorld;

const PAGE = "https://www.linkedin.com/company/copper-harbor-labs";
const NAME = "Copper Harbor Labs";
const DOMAIN = "copper-harbor.example";
type Inputs = readonly (readonly [label: string, input: unknown])[];
/** No company key, a person's key beside one, or a LinkedIn link that is not a company page. */
const NOT_A_COMPANY: Inputs = [
  ["no key", {}],
  ["a country hint alone", { countryHint: "GB" }],
  ["a first name", { name: NAME, firstName: "Ada" }],
  ["an email", { domain: DOMAIN, email: "ada@copper-harbor.example" }],
  ["a title", { linkedinUrl: PAGE, title: "Head of Growth" }],
  ["an address", { name: NAME, address: "1 Example Street" }],
  ["a member's profile", { linkedinUrl: "https://www.linkedin.com/in/ada-example" }],
  ["a company page's subpage", { linkedinUrl: `${PAGE}/people` }],
  ["a school's page", { linkedinUrl: "https://www.linkedin.com/school/copper-harbor-academy" }],
  ["a page off LinkedIn", { linkedinUrl: "https://copper-harbor.example/company/copper" }],
];
/** A company's key off the port's form. */
const OFF_FORM: Inputs = [
  ["a page over http", { linkedinUrl: PAGE.replace("https:", "http:") }],
  ["a page without www.", { linkedinUrl: PAGE.replace("www.", "") }],
  ["a page with a trailing slash", { linkedinUrl: `${PAGE}/` }],
  ["a page with a query", { linkedinUrl: `${PAGE}?trk=example` }],
  ["a domain with www.", { domain: `www.${DOMAIN}` }],
  ["a domain in capitals", { domain: DOMAIN.toUpperCase() }],
  ["a URL for a domain", { domain: `https://${DOMAIN}` }],
  ["an empty name", { name: "" }],
  ["a blank name", { name: "   " }],
  ["a name too long", { name: "x".repeat(NAME_MAX + 1) }],
  ["a country hint in lower case", { name: NAME, countryHint: "gb" }],
  ["a three-letter country hint", { name: NAME, countryHint: "GBR" }],
];

/** The error is the port's `code`; `check` reads its details. */
const failsWith =
  (code: string, check?: (details: Record<string, unknown>) => void) => (error: unknown) => {
    assert.ok(isAppError(error) && error.code === code, `${code}, not ${String(error)}`);
    check?.(error.details ?? {});
    return true;
  };

export function companyDataCases(world: CompanyDataWorld): ContractCases<typeof companyDataPort> {
  if (world.live && platformConfig.APP_ENV === "production") {
    throw new Error("the company-data live suite is refused under APP_ENV=production");
  }
  /** A case of the offline world only: a live run makes its one lookup and nothing else. */
  const offline =
    (run: (port: CompanyData, offlineWorld: OfflineWorld) => Promise<void>) =>
    async (port: CompanyData, t: TestContext) => {
      if (world.live) return t.skip("offline only: a live run makes one lookup");
      await run(port, world);
    };
  /** Each input refused at the boundary, so that nothing reaches the vendor. */
  const refused = (inputs: Inputs) =>
    offline(async (port, offlineWorld) => {
      const before = offlineWorld.calls();
      for (const [label, input] of inputs) {
        const lookup = port.lookupCompany(input as CompanyLookup);
        await assert.rejects(lookup, failsWith("company_data_input_invalid"), label);
      }
      assert.equal(offlineWorld.calls(), before, "nothing reached the vendor");
    });
  /** The vendor's next answer fails with `code`; the call after it finds the company again. */
  const failsOnce = (
    code: CompanyDataFailure,
    check?: (details: Record<string, unknown>) => void,
  ) =>
    offline(async (port, offlineWorld) => {
      const { lookup, facts } = await offlineWorld.company();
      offlineWorld.failNext(code);
      await assert.rejects(port.lookupCompany(lookup), failsWith(code, check));
      const again = await port.lookupCompany(lookup);
      assert.deepEqual(again, { result: "found", company: facts }, "the next call's only");
    });

  return {
    "finds the company the world names, in the port's words": async (port) => {
      if (world.live) {
        const answer = await port.lookupCompany(await world.company());
        assert.equal(answer.result, "found", "the company the owner named");
        return;
      }
      const { lookup, facts } = await world.company();
      assert.deepEqual(await port.lookupCompany(lookup), { result: "found", company: facts });
    },
    "answers not_found for a company it does not know": offline(async (port, offlineWorld) => {
      const unknown = await offlineWorld.unknown();
      assert.deepEqual(await port.lookupCompany(unknown), { result: "not_found" });
    }),
    "refuses no company key, a person's key or a link that is not a company page, before any call: company_data_input_invalid":
      refused(NOT_A_COMPANY),
    "refuses a key off its form, before any call: company_data_input_invalid": refused(OFF_FORM),
    "a rate limit is company_data_rate_limited, with the seconds it asks to wait": failsOnce(
      "company_data_rate_limited",
      (details) => assert.equal(details.retryAfterSec, RETRY_AFTER_SEC),
    ),
    "the vendor's free calls or credits gone are company_data_allowance_spent": failsOnce(
      "company_data_allowance_spent",
    ),
    "a refused key is company_data_unauthorized": failsOnce("company_data_unauthorized"),
    "any other failure is company_data_provider_error, with the status only": failsOnce(
      "company_data_provider_error",
      (details) => assert.deepEqual(details, { status: PROVIDER_ERROR_STATUS }),
    ),
  };
}

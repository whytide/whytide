// The email-finder port's contract (README.md "The contract suite"): what every adapter does, run by
// each adapter's tests/contract.test.ts in its world. A live world, the vendor's API with the owner's
// key, gets exactly one lookup, of the person it names, and every other case skips: a free plan's
// searches are few. The live suite refuses to start under APP_ENV=production. An offline world, the
// fake or an adapter's recorded answers served on 127.0.0.1, gets every case: the person found, with
// and without the vendor's own verdict; an unknown one not_found; the inputs refused before any call;
// and each of the port's codes from the vendor's answer, for the next call only.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { isAppError, platformConfig } from "@whytide/platform";
import type { PortInstance } from "../_pattern/index.ts";
import type { ContractCases } from "../testing/index.ts";
import { NAME_MAX, type VENDOR_VERDICTS } from "./constants.ts";
import type { emailFinderPort, FindEmailInput, FindEmailResult } from "./port.ts";

type EmailFinder = PortInstance<typeof emailFinderPort>;

/** The port's codes a vendor's answer maps to. */
export type EmailFinderFailure =
  | "finder_rate_limited"
  | "finder_allowance_spent"
  | "finder_unauthorized"
  | "finder_provider_error";

/** The seconds the contract's rate limit asks to wait, and the status of its provider error. */
export const RETRY_AFTER_SEC = 30;
export const PROVIDER_ERROR_STATUS = 503;

/** A person an offline world's adapter finds: the lookup, and the answer it gives in the port's words. */
export type WorldPerson = {
  readonly person: FindEmailInput;
  readonly address: string;
  readonly vendorVerdict?: (typeof VENDOR_VERDICTS)[number];
};
/** The vendor's API with the owner's key: the one person the owner may look up. */
export type LiveWorld = {
  readonly live: true;
  readonly person: () => FindEmailInput | Promise<FindEmailInput>;
};
/** The fake, or an adapter's recorded answers. Each hook runs inside its case, after a fake's reset. */
export type OfflineWorld = {
  readonly live: false;
  /** A person the adapter finds, without a check of its own. */
  readonly person: () => WorldPerson | Promise<WorldPerson>;
  /** A person whose address the vendor checked itself: `vendorVerdict` set. */
  readonly checked: () => WorldPerson | Promise<WorldPerson>;
  /** A person the adapter does not find. */
  readonly unknown: () => FindEmailInput | Promise<FindEmailInput>;
  /**
   * The vendor's next answer is one the port reads as `code`: the rate limit asks RETRY_AFTER_SEC,
   * the provider error answers PROVIDER_ERROR_STATUS.
   */
  readonly failNext: (code: EmailFinderFailure) => void;
  /** How many calls reached the vendor so far. */
  readonly calls: () => number;
};
export type EmailFinderWorld = LiveWorld | OfflineWorld;

const PERSON = { firstName: "Ada", lastName: "Example", companyDomain: "copper-harbor.example" };
/** Any key beside the three, a name empty or blank, or a domain that is not a host name. */
const REFUSED: readonly (readonly [label: string, input: unknown])[] = [
  ["no key", {}],
  ["no last name", { firstName: "Ada", companyDomain: PERSON.companyDomain }],
  ["no domain", { firstName: "Ada", lastName: "Example" }],
  ["a title", { ...PERSON, title: "Head of Growth" }],
  ["a LinkedIn profile", { ...PERSON, linkedinUrl: "https://www.linkedin.com/in/ada-example" }],
  ["a full name", { ...PERSON, fullName: "Ada Example" }],
  ["a person's id", { ...PERSON, personId: "per_01" }],
  ["a company name", { ...PERSON, companyName: "Copper Harbor Labs" }],
  ["an empty first name", { ...PERSON, firstName: "" }],
  ["a blank last name", { ...PERSON, lastName: "  " }],
  ["a name too long", { ...PERSON, lastName: "x".repeat(NAME_MAX + 1) }],
  ["a domain with www.", { ...PERSON, companyDomain: `www.${PERSON.companyDomain}` }],
  ["a domain in capitals", { ...PERSON, companyDomain: PERSON.companyDomain.toUpperCase() }],
  ["a URL for a domain", { ...PERSON, companyDomain: `https://${PERSON.companyDomain}` }],
  ["an address for a domain", { ...PERSON, companyDomain: `ada@${PERSON.companyDomain}` }],
  ["a domain of one label", { ...PERSON, companyDomain: "localhost" }],
];

/** The error is the port's `code`; `check` reads its details. */
const failsWith =
  (code: string, check?: (details: Record<string, unknown>) => void) => (error: unknown) => {
    assert.ok(isAppError(error) && error.code === code, `${code}, not ${String(error)}`);
    check?.(error.details ?? {});
    return true;
  };

/** The answer for a world's person, in the port's words. */
const foundAnswer = ({ address, vendorVerdict }: WorldPerson): FindEmailResult =>
  vendorVerdict === undefined
    ? { result: "found", address }
    : { result: "found", address, vendorVerdict };

export function emailFinderCases(world: EmailFinderWorld): ContractCases<typeof emailFinderPort> {
  if (world.live && platformConfig.APP_ENV === "production") {
    throw new Error("the email-finder live suite is refused under APP_ENV=production");
  }
  /** A case of the offline world only: a live run makes its one lookup and nothing else. */
  const offline =
    (run: (port: EmailFinder, offlineWorld: OfflineWorld) => Promise<void>) =>
    async (port: EmailFinder, t: TestContext) => {
      if (world.live) return t.skip("offline only: a live run makes one lookup");
      await run(port, world);
    };
  /** The vendor's next answer fails with `code`; the call after it finds the person again. */
  const failsOnce = (
    code: EmailFinderFailure,
    check?: (details: Record<string, unknown>) => void,
  ) =>
    offline(async (port, offlineWorld) => {
      const found = await offlineWorld.person();
      offlineWorld.failNext(code);
      await assert.rejects(port.findEmail(found.person), failsWith(code, check));
      assert.deepEqual(await port.findEmail(found.person), foundAnswer(found), "the next only");
    });

  return {
    "finds the person the world names, in the port's words": async (port) => {
      if (world.live) {
        const answer = await port.findEmail(await world.person());
        assert.equal(answer.result, "found", "the person the owner named");
        return;
      }
      const found = await world.person();
      assert.equal(found.vendorVerdict, undefined, "the world's person, without a vendor's check");
      assert.deepEqual(await port.findEmail(found.person), foundAnswer(found));
    },
    "answers the vendor's own check as vendorVerdict, one of the five": offline(
      async (port, offlineWorld) => {
        const checked = await offlineWorld.checked();
        assert.ok(checked.vendorVerdict !== undefined, "the world's person, with a vendor's check");
        assert.deepEqual(await port.findEmail(checked.person), foundAnswer(checked));
      },
    ),
    "answers not_found for a person it does not find": offline(async (port, offlineWorld) => {
      const unknown = await offlineWorld.unknown();
      assert.deepEqual(await port.findEmail(unknown), { result: "not_found" });
    }),
    "refuses any key beside the three, an empty name or a domain that is not a host name, before any call: finder_input_invalid":
      offline(async (port, offlineWorld) => {
        const before = offlineWorld.calls();
        for (const [label, input] of REFUSED) {
          const lookup = port.findEmail(input as FindEmailInput);
          await assert.rejects(lookup, failsWith("finder_input_invalid"), label);
        }
        assert.equal(offlineWorld.calls(), before, "nothing reached the vendor");
      }),
    "a rate limit is finder_rate_limited, with the seconds it asks to wait": failsOnce(
      "finder_rate_limited",
      (details) => assert.equal(details.retryAfterSec, RETRY_AFTER_SEC),
    ),
    "the vendor's free searches or credits gone are finder_allowance_spent":
      failsOnce("finder_allowance_spent"),
    "a refused key is finder_unauthorized": failsOnce("finder_unauthorized"),
    "any other failure is finder_provider_error, with the status only": failsOnce(
      "finder_provider_error",
      (details) => assert.deepEqual(details, { status: PROVIDER_ERROR_STATUS }),
    ),
  };
}

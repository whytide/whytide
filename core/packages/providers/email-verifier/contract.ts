// The email-verifier port's contract (README.md "The contract suite"): what every adapter does, run by
// each adapter's tests/contract.test.ts in its world. A live world, the vendor's API with the owner's
// key, gets exactly one check, of the address it names, and every other case skips: a free plan's
// checks are few. The live suite refuses to start under APP_ENV=production. An offline world, the
// fake or an adapter's recorded answers served on 127.0.0.1, gets every case: each of the five
// verdicts in the port's words, `catch_all` apart from `valid`; the inputs refused before any call;
// and each of the port's codes from the vendor's answer, for the next call only.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { isAppError, platformConfig } from "@whytide/platform";
import type { PortInstance } from "../_pattern/index.ts";
import type { ContractCases } from "../testing/index.ts";
import { ADDRESS_MAX, EMAIL_VERDICTS } from "./constants.ts";
import type { EmailVerdict, emailVerifierPort } from "./port.ts";

type EmailVerifier = PortInstance<typeof emailVerifierPort>;

/** The port's codes a vendor's answer maps to. */
export type EmailVerifierFailure =
  | "verifier_rate_limited"
  | "verifier_allowance_spent"
  | "verifier_unauthorized"
  | "verifier_provider_error";

/** The seconds the contract's rate limit asks to wait, and the status of its provider error. */
export const RETRY_AFTER_SEC = 30;
export const PROVIDER_ERROR_STATUS = 503;

/** The vendor's API with the owner's key: the one address the owner may have checked. */
export type LiveWorld = {
  readonly live: true;
  readonly address: () => string | Promise<string>;
};
/** The fake, or an adapter's recorded answers. Each hook runs inside its case, after a fake's reset. */
export type OfflineWorld = {
  readonly live: false;
  /** An address the adapter answers `verdict` for, each of the five. */
  readonly address: (verdict: EmailVerdict) => string | Promise<string>;
  /**
   * The vendor's next answer is one the port reads as `code`: the rate limit asks RETRY_AFTER_SEC,
   * the provider error answers PROVIDER_ERROR_STATUS.
   */
  readonly failNext: (code: EmailVerifierFailure) => void;
  /** How many calls reached the vendor so far. */
  readonly calls: () => number;
};
export type EmailVerifierWorld = LiveWorld | OfflineWorld;

const ADDRESS = "ada.example@copper-harbor.example";
/** Anything but the address alone, or an address off the port's form. */
const REFUSED: readonly (readonly [label: string, input: unknown])[] = [
  ["no key", {}],
  ["a first name beside it", { address: ADDRESS, firstName: "Ada" }],
  ["a company domain beside it", { address: ADDRESS, companyDomain: "copper-harbor.example" }],
  ["a person's id beside it", { address: ADDRESS, personId: "per_01" }],
  ["an empty address", { address: "" }],
  ["no @", { address: "ada.example.copper-harbor.example" }],
  ["no domain", { address: "ada.example@" }],
  ["a domain of one label", { address: "ada@localhost" }],
  ["capitals", { address: ADDRESS.toUpperCase() }],
  ["a display name", { address: `Ada Example <${ADDRESS}>` }],
  ["a space", { address: ` ${ADDRESS}` }],
  ["two addresses", { address: `${ADDRESS},grace@copper-harbor.example` }],
  ["too long", { address: `${"a".repeat(ADDRESS_MAX)}@copper-harbor.example` }],
];

/** The error is the port's `code`; `check` reads its details. */
const failsWith =
  (code: string, check?: (details: Record<string, unknown>) => void) => (error: unknown) => {
    assert.ok(isAppError(error) && error.code === code, `${code}, not ${String(error)}`);
    check?.(error.details ?? {});
    return true;
  };

/** A verdict of the five and a Date: the port's words. */
function assertChecked(answer: { verdict: string; checkedAt: Date }, verdict?: EmailVerdict): void {
  assert.ok((EMAIL_VERDICTS as readonly string[]).includes(answer.verdict), answer.verdict);
  if (verdict !== undefined) assert.equal(answer.verdict, verdict);
  assert.ok(answer.checkedAt instanceof Date && !Number.isNaN(answer.checkedAt.getTime()));
}

export function emailVerifierCases(
  world: EmailVerifierWorld,
): ContractCases<typeof emailVerifierPort> {
  if (world.live && platformConfig.APP_ENV === "production") {
    throw new Error("the email-verifier live suite is refused under APP_ENV=production");
  }
  /** A case of the offline world only: a live run makes its one check and nothing else. */
  const offline =
    (run: (port: EmailVerifier, offlineWorld: OfflineWorld) => Promise<void>) =>
    async (port: EmailVerifier, t: TestContext) => {
      if (world.live) return t.skip("offline only: a live run makes one check");
      await run(port, world);
    };
  /** The vendor's next answer fails with `code`; the call after it checks the address again. */
  const failsOnce = (
    code: EmailVerifierFailure,
    check?: (details: Record<string, unknown>) => void,
  ) =>
    offline(async (port, offlineWorld) => {
      const address = await offlineWorld.address("valid");
      offlineWorld.failNext(code);
      await assert.rejects(port.verifyEmail({ address }), failsWith(code, check));
      assertChecked(await port.verifyEmail({ address }), "valid");
    });

  return {
    "checks the address the world names, in the port's words": async (port) => {
      if (world.live) {
        assertChecked(await port.verifyEmail({ address: await world.address() }));
        return;
      }
      const address = await world.address("valid");
      assertChecked(await port.verifyEmail({ address }), "valid");
    },
    "answers each of the five verdicts, catch_all never folded into valid": offline(
      async (port, offlineWorld) => {
        for (const verdict of EMAIL_VERDICTS) {
          const address = await offlineWorld.address(verdict);
          assertChecked(await port.verifyEmail({ address }), verdict);
        }
      },
    ),
    "refuses anything but the address alone, or an address off its form, before any call: verifier_input_invalid":
      offline(async (port, offlineWorld) => {
        const before = offlineWorld.calls();
        for (const [label, input] of REFUSED) {
          const check = port.verifyEmail(input as { address: string });
          await assert.rejects(check, failsWith("verifier_input_invalid"), label);
        }
        assert.equal(offlineWorld.calls(), before, "nothing reached the vendor");
      }),
    "a rate limit is verifier_rate_limited, with the seconds it asks to wait": failsOnce(
      "verifier_rate_limited",
      (details) => assert.equal(details.retryAfterSec, RETRY_AFTER_SEC),
    ),
    "the vendor's free checks or credits gone are verifier_allowance_spent": failsOnce(
      "verifier_allowance_spent",
    ),
    "a refused key is verifier_unauthorized": failsOnce("verifier_unauthorized"),
    "any other failure is verifier_provider_error, with the status only": failsOnce(
      "verifier_provider_error",
      (details) => assert.deepEqual(details, { status: PROVIDER_ERROR_STATUS }),
    ),
  };
}

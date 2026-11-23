// The fake's contract suite (../../README.md "The contract suite"), in the world of world.ts, then the
// fake's own: `valid` by default, verdictFor() for each of the five, in any case; setAllowance through
// the registry; failNext's details; create() under APP_ENV=production.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { getAdapter, getAdapters } from "../../../registry.ts";
import { contractSuite } from "../../../testing/index.ts";
import { EMAIL_VERDICTS } from "../../constants.ts";
import { emailVerifierCases } from "../../contract.ts";
import { emailVerifierPort } from "../../port.ts";
import { PROVIDER_ERROR_STATUS, RETRY_AFTER_SEC } from "../constants.ts";
import { emailVerifierFake, emailVerifierFakeAdapter } from "../index.ts";
import { addressWith, fakeWorld } from "./world.ts";

contractSuite(
  emailVerifierPort,
  emailVerifierFakeAdapter,
  emailVerifierCases(fakeWorld(emailVerifierFake)),
);

/** The fake bound as the registry binds it, reset. */
function boundFake() {
  const verifier = bindPort(emailVerifierPort, emailVerifierFakeAdapter.create(), {
    adapter: "fake",
  });
  emailVerifierFake.reset();
  return verifier;
}

test("every address is valid, checked now, unless verdictFor set another, each of the five, in any case; reset forgets them", async () => {
  const verifier = boundFake();
  const before = Date.now();
  const answer = await verifier.verifyEmail({ address: "grace@granite-orbit.example" });
  assert.equal(answer.verdict, "valid");
  assert.ok(answer.checkedAt.getTime() >= before && answer.checkedAt.getTime() <= Date.now());
  for (const verdict of EMAIL_VERDICTS) {
    emailVerifierFake.verdictFor(addressWith(verdict).toUpperCase(), verdict);
  }
  for (const verdict of EMAIL_VERDICTS) {
    const { verdict: given } = await verifier.verifyEmail({ address: addressWith(verdict) });
    assert.equal(given, verdict, verdict);
  }
  assert.deepEqual(
    emailVerifierFake.recordedCalls.map(({ method, input }) => [method, input]),
    ["grace@granite-orbit.example", ...EMAIL_VERDICTS.map(addressWith)].map((address) => [
      "verifyEmail",
      { address },
    ]),
  );
  emailVerifierFake.reset();
  const again = await verifier.verifyEmail({ address: addressWith("catch_all") });
  assert.equal(again.verdict, "valid", "reset forgot the verdicts");
});

test("setAllowance sets the allowance the registry's fake exposes, read on every access; reset clears it", async () => {
  const [fake] = await getAdapters(emailVerifierPort, ["fake"]);
  assert.ok(fake);
  assert.equal(fake, await getAdapter(emailVerifierPort, "fake"));
  emailVerifierFake.reset();
  assert.deepEqual([fake.allowance, fake.openData], [null, false]);
  emailVerifierFake.setAllowance({ calls: 100, per: "day" });
  assert.deepEqual(fake.allowance, { calls: 100, per: "day" });
  assert.deepEqual(emailVerifierFakeAdapter.allowance, { calls: 100, per: "day" });
  emailVerifierFake.reset();
  assert.equal(fake.allowance, null);
  assert.equal(Object.keys(fake).includes("allowance"), false, "not among the methods");
});

test("failNext's rate limit carries retryAfterSec and its provider error a status, unless the details give them", async () => {
  const verifier = boundFake();
  type Code = Parameters<typeof emailVerifierFake.failNext>[0];
  const failure = async (code: Code, details?: Record<string, unknown>) => {
    emailVerifierFake.failNext(code, details);
    const error = await verifier.verifyEmail({ address: addressWith("valid") }).then(
      () => assert.fail("the call failed"),
      (caught: unknown) => caught,
    );
    assert.ok(isAppError(error) && error.code === code);
    return error.details;
  };
  assert.deepEqual(await failure("verifier_rate_limited"), { retryAfterSec: RETRY_AFTER_SEC });
  assert.deepEqual(await failure("verifier_rate_limited", { retryAfterSec: 5 }), {
    retryAfterSec: 5,
  });
  assert.deepEqual(await failure("verifier_provider_error"), { status: PROVIDER_ERROR_STATUS });
  assert.deepEqual(await failure("verifier_provider_error", { status: 503 }), { status: 503 });
  assert.equal(await failure("verifier_allowance_spent"), undefined);
  assert.equal(await failure("verifier_unauthorized"), undefined);
});

test("create() refuses APP_ENV=production with adapter_invalid, through the registry too", async () => {
  const fake = JSON.stringify(import.meta.resolve("../index.ts"));
  const registry = JSON.stringify(import.meta.resolve("../../../registry.ts"));
  const port = JSON.stringify(import.meta.resolve("../../port.ts"));
  const script = [
    `const { emailVerifierFakeAdapter } = await import(${fake});`,
    `const { getAdapter, getAdapters } = await import(${registry});`,
    `const { emailVerifierPort } = await import(${port});`,
    "const outcome = (run) => run().then(() => 'created', (error) => error.code);",
    "const direct = await outcome(async () => emailVerifierFakeAdapter.create());",
    "const one = await outcome(() => getAdapter(emailVerifierPort, 'fake'));",
    "const listed = await outcome(() => getAdapters(emailVerifierPort, ['fake']));",
    "console.log(`${direct} ${one} ${listed}`);",
  ].join("\n");
  const runAs = (APP_ENV: string) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APP_ENV },
    }).then(({ stdout }) => `${APP_ENV} ${stdout.trim()}`);
  assert.deepEqual(await Promise.all(["test", "production"].map(runAs)), [
    "test created created created",
    "production adapter_invalid adapter_invalid adapter_invalid",
  ]);
});

// The fake's contract suite (../../README.md "The contract suite"), in the world of world.ts, then the
// fake's own: the address it makes of a name; notFoundFor() and vendorVerdictFor(), each of the five,
// in any case, the last set winning; setAllowance through the registry; failNext's details; create()
// under APP_ENV=production.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { getAdapter, getAdapters } from "../../../registry.ts";
import { contractSuite } from "../../../testing/index.ts";
import { VENDOR_VERDICTS } from "../../constants.ts";
import { emailFinderCases } from "../../contract.ts";
import { emailFinderPort } from "../../port.ts";
import { PROVIDER_ERROR_STATUS, RETRY_AFTER_SEC } from "../constants.ts";
import { emailFinderFake, emailFinderFakeAdapter } from "../index.ts";
import { ADA, DOMAIN, fakeWorld } from "./world.ts";

contractSuite(
  emailFinderPort,
  emailFinderFakeAdapter,
  emailFinderCases(fakeWorld(emailFinderFake)),
);

/** The fake bound as the registry binds it, reset. */
function boundFake() {
  const finder = bindPort(emailFinderPort, emailFinderFakeAdapter.create(), { adapter: "fake" });
  emailFinderFake.reset();
  return finder;
}
const at = (firstName: string, lastName: string) => ({
  firstName,
  lastName,
  companyDomain: DOMAIN,
});

test("the fake finds <first>.<last>@<companyDomain>, each name lower case, without marks and anything but a to z and digits; not_found when a name keeps nothing", async () => {
  const finder = boundFake();
  const lookups = [
    [at("Ada", "Example"), `ada.example@${DOMAIN}`],
    [at("JOSÉ", "Núñez"), `jose.nunez@${DOMAIN}`],
    [at("Mary Ann", "O'Brien-Smith"), `maryann.obriensmith@${DOMAIN}`],
    [at("Zoë", "Ångström 3rd"), `zoe.angstrom3rd@${DOMAIN}`],
    [at("李", "Example"), undefined],
    [at("Ada", "—"), undefined],
  ] as const;
  for (const [person, address] of lookups) {
    const answer = address === undefined ? { result: "not_found" } : { result: "found", address };
    assert.deepEqual(await finder.findEmail(person), answer, JSON.stringify(person));
  }
  assert.deepEqual(
    emailFinderFake.recordedCalls.map(({ method, input }) => [method, input]),
    lookups.map(([person]) => ["findEmail", person]),
  );
});

test("notFoundFor and vendorVerdictFor, each of the five, for a person in any case, the last set winning; another domain is another person; reset forgets them", async () => {
  const finder = boundFake();
  const address = `ada.example@${DOMAIN}`;
  for (const verdict of VENDOR_VERDICTS) {
    emailFinderFake.vendorVerdictFor("ADA", "example", DOMAIN.toUpperCase(), verdict);
    assert.deepEqual(await finder.findEmail(ADA), {
      result: "found",
      address,
      vendorVerdict: verdict,
    });
  }
  emailFinderFake.notFoundFor("ada", "EXAMPLE", DOMAIN);
  assert.deepEqual(await finder.findEmail(ADA), { result: "not_found" });
  const elsewhere = { ...ADA, companyDomain: "granite-orbit.example" };
  const found = { result: "found", address: "ada.example@granite-orbit.example" };
  assert.deepEqual(await finder.findEmail(elsewhere), found, "only at that domain");
  emailFinderFake.vendorVerdictFor("Ada", "Example", DOMAIN, "catch_all");
  const caught = await finder.findEmail(ADA);
  assert.deepEqual(
    caught,
    { result: "found", address, vendorVerdict: "catch_all" },
    "the last set",
  );
  emailFinderFake.reset();
  assert.deepEqual(await finder.findEmail(ADA), { result: "found", address }, "reset forgot it");
});

test("setAllowance sets the allowance the registry's fake exposes, read on every access; reset clears it", async () => {
  const [fake] = await getAdapters(emailFinderPort, ["fake"]);
  assert.ok(fake);
  assert.equal(fake, await getAdapter(emailFinderPort, "fake"));
  emailFinderFake.reset();
  assert.deepEqual([fake.allowance, fake.openData], [null, false]);
  emailFinderFake.setAllowance({ calls: 50, per: "month" });
  assert.deepEqual(fake.allowance, { calls: 50, per: "month" });
  assert.deepEqual(emailFinderFakeAdapter.allowance, { calls: 50, per: "month" });
  emailFinderFake.reset();
  assert.equal(fake.allowance, null);
  assert.equal(Object.keys(fake).includes("allowance"), false, "not among the methods");
});

test("failNext's rate limit carries retryAfterSec and its provider error a status, unless the details give them", async () => {
  const finder = boundFake();
  type Code = Parameters<typeof emailFinderFake.failNext>[0];
  const failure = async (code: Code, details?: Record<string, unknown>) => {
    emailFinderFake.failNext(code, details);
    const error = await finder.findEmail(ADA).then(
      () => assert.fail("the call failed"),
      (caught: unknown) => caught,
    );
    assert.ok(isAppError(error) && error.code === code);
    return error.details;
  };
  assert.deepEqual(await failure("finder_rate_limited"), { retryAfterSec: RETRY_AFTER_SEC });
  assert.deepEqual(await failure("finder_rate_limited", { retryAfterSec: 5 }), {
    retryAfterSec: 5,
  });
  assert.deepEqual(await failure("finder_provider_error"), { status: PROVIDER_ERROR_STATUS });
  assert.deepEqual(await failure("finder_provider_error", { status: 503 }), { status: 503 });
  assert.equal(await failure("finder_allowance_spent"), undefined);
  assert.equal(await failure("finder_unauthorized"), undefined);
});

test("create() refuses APP_ENV=production with adapter_invalid, through the registry too", async () => {
  const fake = JSON.stringify(import.meta.resolve("../index.ts"));
  const registry = JSON.stringify(import.meta.resolve("../../../registry.ts"));
  const port = JSON.stringify(import.meta.resolve("../../port.ts"));
  const script = [
    `const { emailFinderFakeAdapter } = await import(${fake});`,
    `const { getAdapter, getAdapters } = await import(${registry});`,
    `const { emailFinderPort } = await import(${port});`,
    "const outcome = (run) => run().then(() => 'created', (error) => error.code);",
    "const direct = await outcome(async () => emailFinderFakeAdapter.create());",
    "const one = await outcome(() => getAdapter(emailFinderPort, 'fake'));",
    "const listed = await outcome(() => getAdapters(emailFinderPort, ['fake']));",
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

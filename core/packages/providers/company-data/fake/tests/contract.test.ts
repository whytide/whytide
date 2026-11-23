// The fake's contract suite (../../README.md "The contract suite"), in the world of world.ts, then the
// fake's own: seedCompany's keys, in any case, and the order a lookup tries them; setAllowance
// through the registry; failNext's details; create() under APP_ENV=production.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { getAdapter, getAdapters } from "../../../registry.ts";
import { contractSuite } from "../../../testing/index.ts";
import { companyDataCases } from "../../contract.ts";
import { type CompanyFacts, companyDataPort } from "../../port.ts";
import { PROVIDER_ERROR_STATUS, RETRY_AFTER_SEC } from "../constants.ts";
import { companyDataFake, companyDataFakeAdapter } from "../index.ts";
import { FACTS, fakeWorld, PAGE } from "./world.ts";

contractSuite(
  companyDataPort,
  companyDataFakeAdapter,
  companyDataCases(fakeWorld(companyDataFake)),
);

const GRANITE: CompanyFacts = { name: "Granite Orbit Works", industry: "Logistics" };
const MEADOW: CompanyFacts = { name: "Quiet Meadow Studio", employeeRange: { from: 10_001 } };

/** The fake bound as the registry binds it, reset. */
function boundFake() {
  const companyData = bindPort(companyDataPort, companyDataFakeAdapter.create(), {
    adapter: "fake",
  });
  companyDataFake.reset();
  return companyData;
}
const found = (company: CompanyFacts) => ({ result: "found", company });

test("seedCompany keys a company by its page, its domain or its name, in any case; a lookup tries the page, then the domain, then the name; anything unseeded is not_found", async () => {
  const companyData = boundFake();
  companyDataFake.seedCompany(PAGE, FACTS);
  companyDataFake.seedCompany("granite-orbit.example", GRANITE);
  companyDataFake.seedCompany("Quiet Meadow Studio", MEADOW);
  const lookups = [
    [{ linkedinUrl: PAGE.replace("copper-harbor-labs", "Copper-Harbor-Labs") }, found(FACTS)],
    [{ domain: "granite-orbit.example" }, found(GRANITE)],
    [{ name: "quiet meadow studio" }, found(MEADOW)],
    [{ name: "QUIET MEADOW STUDIO", countryHint: "JP" }, found(MEADOW)],
    [
      { linkedinUrl: PAGE, domain: "granite-orbit.example", name: "Quiet Meadow Studio" },
      found(FACTS),
    ],
    [{ domain: "granite-orbit.example", name: "Quiet Meadow Studio" }, found(GRANITE)],
    [{ domain: "nobody-seeded.example", name: "Quiet Meadow Studio" }, found(MEADOW)],
    [{ name: "Nobody Seeded" }, { result: "not_found" }],
  ] as const;
  for (const [input, answer] of lookups) {
    assert.deepEqual(await companyData.lookupCompany(input), answer, JSON.stringify(input));
  }
  assert.deepEqual(
    companyDataFake.recordedCalls.map(({ method, input }) => [method, input]),
    lookups.map(([input]) => ["lookupCompany", input]),
  );
  const answer = await companyData.lookupCompany({ domain: "granite-orbit.example" });
  assert.ok(answer.result === "found");
  Object.assign(answer.company, { industry: "Changed" });
  const again = await companyData.lookupCompany({ domain: "granite-orbit.example" });
  assert.deepEqual(again, found(GRANITE), "a lookup answers a copy");
  companyDataFake.reset();
  assert.deepEqual(await companyData.lookupCompany({ linkedinUrl: PAGE }), { result: "not_found" });
});

test("setAllowance sets the allowance the registry's fake exposes, read on every access; reset clears it; the fake's data is not open data", async () => {
  const [fake] = await getAdapters(companyDataPort, ["fake"]);
  assert.ok(fake);
  assert.equal(fake, await getAdapter(companyDataPort, "fake"));
  companyDataFake.reset();
  assert.equal(fake.allowance, null);
  assert.equal(fake.openData, false);
  companyDataFake.setAllowance({ calls: 2, per: "day" });
  assert.deepEqual(fake.allowance, { calls: 2, per: "day" });
  assert.deepEqual(companyDataFakeAdapter.allowance, { calls: 2, per: "day" });
  companyDataFake.setAllowance({ calls: 300, per: "month" });
  assert.deepEqual(fake.allowance, { calls: 300, per: "month" });
  companyDataFake.reset();
  assert.equal(fake.allowance, null);
  assert.equal(Object.keys(fake).includes("allowance"), false, "not among the methods");
});

test("failNext's rate limit carries retryAfterSec and its provider error a status, unless the details give them", async () => {
  const companyData = boundFake();
  const lookup = { name: "Copper Harbor Labs" };
  type Code = Parameters<typeof companyDataFake.failNext>[0];
  const failure = async (code: Code, details?: Record<string, unknown>) => {
    companyDataFake.failNext(code, details);
    const error = await companyData.lookupCompany(lookup).then(
      () => assert.fail("the call failed"),
      (caught: unknown) => caught,
    );
    assert.ok(isAppError(error) && error.code === code);
    return error.details;
  };
  assert.deepEqual(await failure("company_data_rate_limited"), { retryAfterSec: RETRY_AFTER_SEC });
  assert.deepEqual(await failure("company_data_rate_limited", { retryAfterSec: 5 }), {
    retryAfterSec: 5,
  });
  assert.deepEqual(await failure("company_data_provider_error"), {
    status: PROVIDER_ERROR_STATUS,
  });
  assert.deepEqual(await failure("company_data_provider_error", { status: 503 }), { status: 503 });
  assert.equal(await failure("company_data_allowance_spent"), undefined);
  assert.equal(await failure("company_data_unauthorized"), undefined);
});

test("create() refuses APP_ENV=production with adapter_invalid, through the registry too", async () => {
  const fake = JSON.stringify(import.meta.resolve("../index.ts"));
  const registry = JSON.stringify(import.meta.resolve("../../../registry.ts"));
  const port = JSON.stringify(import.meta.resolve("../../port.ts"));
  const script = [
    `const { companyDataFakeAdapter } = await import(${fake});`,
    `const { getAdapter, getAdapters } = await import(${registry});`,
    `const { companyDataPort } = await import(${port});`,
    "const outcome = (run) => run().then(() => 'created', (error) => error.code);",
    "const direct = await outcome(async () => companyDataFakeAdapter.create());",
    "const one = await outcome(() => getAdapter(companyDataPort, 'fake'));",
    "const listed = await outcome(() => getAdapters(companyDataPort, ['fake']));",
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

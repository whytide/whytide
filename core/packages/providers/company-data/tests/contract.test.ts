// The port's own tests, and the task's suite on the fake taken from the registry (README.md "The
// contract suite"): PROVIDER_COMPANY_DATA=fake through the config and getAdapters gives the fake, on
// which the contract suite runs; any other list fails at start, an empty one lists none; the codes
// are registered with their statuses and in the README's table; an answer off the port's shapes is
// company_data_output_invalid in every environment; no input's value reaches an error, a log line,
// the console or a metric label, and the port opens no span; a live world makes one lookup and never
// runs in production. PROVIDER_COMPANY_DATA is set before the config is imported, which reads it once.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect, promisify } from "node:util";
import {
  collectLogs,
  createLogger,
  httpStatus,
  isAppError,
  recordedMetrics,
  registeredErrors,
} from "@whytide/platform";
import type { AdapterDefinition } from "../../_pattern/index.ts";
import type { CompanyDataFake, CompanyFacts } from "../port.ts";

process.env.PROVIDER_COMPANY_DATA = "fake";
const { bindPort, isFake, registeredAdapters } = await import("../../_pattern/index.ts");
const { getAdapter, getAdapters } = await import("../../registry.ts");
const { contractSuite } = await import("../../testing/index.ts");
const { companyDataCases } = await import("../contract.ts");
const { FACTS, fakeWorld, PAGE } = await import("../fake/tests/world.ts");
const { companyDataConfig, companyDataPort } = await import("../port.ts");

const listed = await getAdapters(companyDataPort, companyDataConfig.PROVIDER_COMPANY_DATA);
const [companyData] = listed;
assert.ok(companyData, "PROVIDER_COMPANY_DATA lists the fake");
const fake = companyData as unknown as CompanyDataFake;
const definition = registeredAdapters(companyDataPort).get("fake");
assert.ok(definition, "the registry loaded the fake");
const fakeAdapter = definition as AdapterDefinition<typeof companyDataPort>;
contractSuite(companyDataPort, fakeAdapter, companyDataCases(fakeWorld(fake)));

test("PROVIDER_COMPANY_DATA=fake lists the fake through the config and getAdapters: the instance getAdapter gives, its controls reachable, no allowance, not open data", async () => {
  assert.deepEqual(companyDataConfig.PROVIDER_COMPANY_DATA, ["fake"]);
  assert.equal(listed.length, 1);
  assert.equal(companyData, await getAdapter(companyDataPort, "fake"));
  assert.ok(isFake(companyData));
  assert.deepEqual([companyData.allowance, companyData.openData], [null, false]);
  assert.equal(companyDataPort.variable, "PROVIDER_COMPANY_DATA");
});

test("PROVIDER_COMPANY_DATA at start: an adapter the registry does not know, one named twice or a name that is no folder name fails; empty lists none", async () => {
  const registry = JSON.stringify(import.meta.resolve("../../registry.ts"));
  const port = JSON.stringify(import.meta.resolve("../port.ts"));
  const script = [
    "try {",
    `  const { companyDataConfig, companyDataPort } = await import(${port});`,
    `  const { getAdapters } = await import(${registry});`,
    "  const listed = await getAdapters(companyDataPort, companyDataConfig.PROVIDER_COMPANY_DATA);",
    "  console.log(`started with ${listed.length}`);",
    "} catch (error) { console.log(error.code); }",
  ].join("\n");
  const startWith = (PROVIDER_COMPANY_DATA: string) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APP_ENV: "test", PROVIDER_COMPANY_DATA },
    }).then(({ stdout }) => `${PROVIDER_COMPANY_DATA}: ${stdout.trim()}`);
  const lists = ["fake", "", "fake,no-such-vendor", "fake,fake", "Fake", "fake, fake"];
  assert.deepEqual(await Promise.all(lists.map(startWith)), [
    "fake: started with 1",
    ": started with 0",
    "fake,no-such-vendor: provider_unknown",
    "fake,fake: config_invalid",
    "Fake: config_invalid",
    "fake, fake: config_invalid",
  ]);
});

test("the codes, with their statuses: the port's four and the pattern's three, each in the README; one method, its outputs checked in every environment", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rows = [...readme.matchAll(/^\| `(company_data_[a-z_]+)` \((\d{3})\) \|/gm)];
  const table = Object.fromEntries(rows.map(([, code, status]) => [code, Number(status)]));
  assert.deepEqual(table, {
    company_data_rate_limited: 429,
    company_data_allowance_spent: 402,
    company_data_unauthorized: 401,
    company_data_provider_error: 502,
  });
  const declared = Object.keys(companyDataPort.errors);
  assert.deepEqual(Object.fromEntries(declared.map((code) => [code, httpStatus(code)])), table);
  const own = Object.values(companyDataPort.codes);
  assert.deepEqual(
    own.map((code) => [code, httpStatus(code)]),
    [
      ["company_data_input_invalid", 400],
      ["company_data_output_invalid", 500],
      ["company_data_error_unmapped", 500],
    ],
  );
  assert.ok(own.every((code) => readme.includes(`\`${code}\``)));
  // definePort registered them, and a code registered twice would have thrown: no other owner.
  const registered = [...registeredErrors().keys()].filter((code) =>
    code.startsWith("company_data_"),
  );
  assert.deepEqual(registered.toSorted(), [...declared, ...own].toSorted());
  assert.deepEqual(Object.keys(companyDataPort.methods), ["lookupCompany"]);
  assert.equal(companyDataPort.alwaysCheckOutputs, true);
});

test("an answer off the port's shapes is company_data_output_invalid, though a binding asks for no check, as production's do", async () => {
  // The fake itself, bound as production binds an adapter: no check asked for.
  const unchecked = bindPort(companyDataPort, fakeAdapter.create(), {
    adapter: "fake",
    checkOutputs: false,
  });
  const found = (company: Record<string, unknown>) => ({
    result: "found",
    company: { industry: "Logistics", ...company },
  });
  const offShape: readonly (readonly [label: string, answer: unknown])[] = [
    ["nothing", undefined],
    ["null", null],
    ["no result", {}],
    ["a result the port does not have", { result: "maybe" }],
    ["found without a company", { result: "found" }],
    ["not_found with a company", { result: "not_found", company: FACTS }],
    ["a name alone", { result: "found", company: { name: FACTS.name } }],
    ["no fact", { result: "found", company: {} }],
    ["a field the port does not declare", found({ revenue: 1_000_000 })],
    ["a person's field", found({ ceoName: "Ada Example" })],
    ["an empty industry", found({ industry: "" })],
    ["an industry too long", found({ industry: "x".repeat(201) })],
    ["a description too long", found({ description: "x".repeat(2_001) })],
    ["no employees", found({ employeeCount: 0 })],
    ["part of an employee", found({ employeeCount: 4.5 })],
    ["a count in text", found({ employeeCount: "42" })],
    ["a range upside down", found({ employeeRange: { from: 50, to: 11 } })],
    ["a range with a label", found({ employeeRange: { from: 11, to: 50, label: "11-50" } })],
    ["a country in lower case", found({ country: "gb" })],
    ["a country by name", found({ country: "United Kingdom" })],
    ["a member's page", found({ linkedinUrl: "https://www.linkedin.com/in/ada-example" })],
    ["a domain with www.", found({ domain: "www.copper-harbor.example" })],
    ["a year in text", found({ foundedYear: "2019" })],
    ["year zero", found({ foundedYear: 0 })],
  ];
  const lookup = { linkedinUrl: PAGE };
  fake.reset();
  for (const [label, answer] of offShape) {
    for (const port of [companyData, unchecked]) {
      fake.answerNext("lookupCompany", answer);
      const refused = (error: unknown) =>
        isAppError(error) && error.code === "company_data_output_invalid";
      await assert.rejects(port.lookupCompany(lookup), refused, label);
    }
  }
  const valid = found({ employeeRange: { from: 10_001 } });
  fake.answerNext("lookupCompany", valid);
  assert.deepEqual(await unchecked.lookupCompany(lookup), valid, "an open band");
});

test("no input's value in an error, a log line, the console or a metric label; the port's code has no logger and opens no span", async (t) => {
  fake.reset();
  const logs = collectLogs();
  const logger = createLogger({ destination: logs.destination });
  const printed: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    t.mock.method(console, level, (...args: unknown[]) => void printed.push(args));
  const page = "https://www.linkedin.com/company/quillmarsh-tide";
  const domain = "quillmarsh-tide.example";
  const name = "Quillmarsh Tide Holdings";
  const facts: CompanyFacts = { name, domain, linkedinUrl: page, industry: "Quillmarsh freight" };
  fake.seedCompany(page, facts);
  const failing = (code: Parameters<CompanyDataFake["failNext"]>[0], input: object) => () => {
    fake.failNext(code);
    return companyData.lookupCompany(input);
  };
  const calls = [
    () => companyData.lookupCompany({ linkedinUrl: page }),
    () => companyData.lookupCompany({ domain: "quillmarsh-elsewhere.example" }),
    () => companyData.lookupCompany({ name, firstName: "Quillmarsh" } as never),
    () => companyData.lookupCompany({ linkedinUrl: "https://www.linkedin.com/in/quillmarsh-ada" }),
    () => companyData.lookupCompany({ domain: "WWW.QUILLMARSH-TIDE.EXAMPLE" }),
    () => companyData.lookupCompany({ name: "Quillmarsh ".repeat(20) }),
    failing("company_data_rate_limited", { name }),
    failing("company_data_allowance_spent", { domain }),
    failing("company_data_unauthorized", { linkedinUrl: page }),
    failing("company_data_provider_error", { name, countryHint: "GB" }),
    () => {
      fake.answerNext("lookupCompany", { result: "found", company: { ...facts, ceo: name } });
      return companyData.lookupCompany({ domain });
    },
  ];
  const errors: unknown[] = [];
  for (const call of calls) {
    const error = await call().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (error === undefined) continue;
    assert.ok(isAppError(error), String(error));
    errors.push(error);
    logger.error({ err: error }, "company lookup refused"); // as a host logs a refusal
  }
  assert.deepEqual(
    errors.map((error) => (isAppError(error) ? error.code : error)),
    [
      ...Array(4).fill("company_data_input_invalid"),
      "company_data_rate_limited",
      "company_data_allowance_spent",
      "company_data_unauthorized",
      "company_data_provider_error",
      "company_data_output_invalid",
    ],
  );
  const labels = (recordedMetrics().get("providers.calls") ?? []).filter(
    (l) => l.port === "company_data",
  );
  assert.ok(labels.length > 0, "the calls were counted");
  const seen = inspect([errors, logs.raw, printed, labels], { depth: Infinity, showHidden: true });
  assert.deepEqual(
    [page, domain, name, "quillmarsh"].filter((value) =>
      seen.toLowerCase().includes(value.toLowerCase()),
    ),
    [],
  );
  assert.equal(logs.lines().length, errors.length, "the refusals were logged");
  const folder = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.split("/").includes("tests"))
    .map((file) => `${folder}${file}`);
  assert.ok(
    files.some((file) => file.endsWith("company-data/port.ts")),
    files.join(),
  );
  const boundary = ["_pattern/port.ts", "_pattern/adapter.ts", "registry.ts"].map((file) =>
    fileURLToPath(new URL(`../../${file}`, import.meta.url)),
  );
  for (const file of [...files, ...boundary]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /console\.|createLogger|withSpan|opentelemetry|\blogger\b/, file);
  }
});

test("a live world gets exactly one lookup, of the company it names, every other case skipped; never under APP_ENV=production", async () => {
  const file = fileURLToPath(new URL("./fixtures/live-world.ts", import.meta.url));
  const reporter = ["--test-reporter=spec", "--test-reporter-destination=stdout"];
  // Without the test runner's own marker, or the child refuses to run a test file inside a test.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const runAs = async (APP_ENV: string) => {
    const child = spawn(process.execPath, ["--test", ...reporter, file], {
      env: { ...env, APP_ENV },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, output };
  };
  const [live, production] = await Promise.all([runAs("test"), runAs("production")]);
  assert.equal(live.code, 0, live.output);
  assert.match(live.output, /live lookups: 1\n/);
  assert.match(live.output, /✔ finds the company the world names, in the port's words/);
  assert.match(live.output, /ℹ pass 2\n/, "the methods, and the one lookup");
  assert.match(live.output, /ℹ skipped 7\n/);
  assert.equal(live.output.match(/# offline only: a live run makes one lookup/g)?.length, 7);
  assert.notEqual(production.code, 0, production.output);
  assert.match(
    production.output,
    /the company-data live suite is refused under APP_ENV=production/,
  );
  assert.doesNotMatch(production.output, /live lookups/);
});

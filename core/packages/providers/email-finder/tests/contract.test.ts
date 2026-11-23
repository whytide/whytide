// The port's own tests, and the task's suite on the fake taken from the registry (README.md "The
// contract suite"): PROVIDER_EMAIL_FINDER=fake through the config and getAdapters gives the fake, on
// which the contract suite runs; the codes are registered with their statuses and in the README's
// table; an answer off the port's shapes, a vendorVerdict outside the five or beside not_found among
// them, is finder_output_invalid in every environment, and the five are the verifier's; no name,
// domain or address reaches an error, a log line, the console or a metric label, and the port opens
// no span; a live world makes one lookup and never runs in production. The list at start, of several
// adapters and of an unknown one, is tests/registry.test.ts's. PROVIDER_EMAIL_FINDER is set before
// the config is imported, which reads it once.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  collectLogs,
  createLogger,
  httpStatus,
  isAppError,
  recordedMetrics,
  registeredErrors,
} from "@whytide/platform";
import type { AdapterDefinition } from "../../_pattern/index.ts";
import { EMAIL_VERDICTS } from "../../email-verifier/constants.ts";
import { VENDOR_VERDICTS } from "../constants.ts";
import type { EmailFinderFake } from "../port.ts";

process.env.PROVIDER_EMAIL_FINDER = "fake";
const { bindPort, isFake, registeredAdapters } = await import("../../_pattern/index.ts");
const { getAdapter, getAdapters } = await import("../../registry.ts");
const { contractSuite } = await import("../../testing/index.ts");
const { emailFinderCases } = await import("../contract.ts");
const { ADA, DOMAIN, fakeWorld } = await import("../fake/tests/world.ts");
const { emailFinderConfig, emailFinderPort } = await import("../port.ts");

const listed = await getAdapters(emailFinderPort, emailFinderConfig.PROVIDER_EMAIL_FINDER);
const [finder] = listed;
assert.ok(finder, "PROVIDER_EMAIL_FINDER lists the fake");
const fake = finder as unknown as EmailFinderFake;
const definition = registeredAdapters(emailFinderPort).get("fake");
assert.ok(definition, "the registry loaded the fake");
const fakeAdapter = definition as AdapterDefinition<typeof emailFinderPort>;
contractSuite(emailFinderPort, fakeAdapter, emailFinderCases(fakeWorld(fake)));

test("PROVIDER_EMAIL_FINDER=fake lists the fake through the config and getAdapters: the instance getAdapter gives, its controls reachable, no allowance", async () => {
  assert.deepEqual(emailFinderConfig.PROVIDER_EMAIL_FINDER, ["fake"]);
  assert.equal(listed.length, 1);
  assert.equal(finder, await getAdapter(emailFinderPort, "fake"));
  assert.ok(isFake(finder));
  assert.equal(finder.allowance, null);
  assert.equal(emailFinderPort.variable, "PROVIDER_EMAIL_FINDER");
});

test("the codes, with their statuses: the port's four, finder_allowance_spent the vendor's credits gone, and the pattern's three, each in the README; one method, its outputs checked in every environment", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rows = [...readme.matchAll(/^\| `(finder_[a-z_]+)` \((\d{3})\) \|/gm)];
  const table = Object.fromEntries(rows.map(([, code, status]) => [code, Number(status)]));
  assert.deepEqual(table, {
    finder_rate_limited: 429,
    finder_allowance_spent: 402,
    finder_unauthorized: 401,
    finder_provider_error: 502,
  });
  const declared = Object.keys(emailFinderPort.errors);
  assert.deepEqual(Object.fromEntries(declared.map((code) => [code, httpStatus(code)])), table);
  const own = Object.values(emailFinderPort.codes);
  assert.deepEqual(
    own.map((code) => [code, httpStatus(code)]),
    [
      ["finder_input_invalid", 400],
      ["finder_output_invalid", 500],
      ["finder_error_unmapped", 500],
    ],
  );
  assert.ok(own.every((code) => readme.includes(`\`${code}\``)));
  // definePort registered them, and a code registered twice would have thrown: no other owner.
  const registered = [...registeredErrors().keys()].filter((code) => code.startsWith("finder_"));
  assert.deepEqual(registered.toSorted(), [...declared, ...own].toSorted());
  assert.deepEqual(Object.keys(emailFinderPort.methods), ["findEmail"]);
  assert.equal(emailFinderPort.alwaysCheckOutputs, true);
});

test("an answer off the port's shapes, a vendorVerdict outside the five or beside not_found among them, is finder_output_invalid, though a binding asks for no check, as production's do; the five are the verifier's", async () => {
  assert.deepEqual(VENDOR_VERDICTS, EMAIL_VERDICTS, "the verifier's five, in its order");
  // The fake itself, bound as production binds an adapter: no check asked for.
  const unchecked = bindPort(emailFinderPort, fakeAdapter.create(), {
    adapter: "fake",
    checkOutputs: false,
  });
  const address = `ada.example@${DOMAIN}`;
  const found = (extra: Record<string, unknown>) => ({ result: "found", address, ...extra });
  const offShape: readonly (readonly [label: string, answer: unknown])[] = [
    ["nothing", undefined],
    ["null", null],
    ["no result", { address }],
    ["a result the port does not have", { result: "maybe", address }],
    ["found without an address", { result: "found" }],
    ["a sixth verdict", found({ vendorVerdict: "accept_all" })],
    ["a verdict in capitals", found({ vendorVerdict: "VALID" })],
    ["a verdict as a score", found({ vendorVerdict: 97 })],
    ["a verdict beside not_found", { result: "not_found", vendorVerdict: "invalid" }],
    ["an address beside not_found", { result: "not_found", address }],
    ["an address in capitals", found({ address: address.toUpperCase() })],
    ["an address with a display name", found({ address: `Ada Example <${address}>` })],
    ["no address at all", found({ address: "ada.example" })],
    ["a field the port does not declare", found({ confidence: 91 })],
    ["the person's name", found({ firstName: "Ada" })],
    ["a source the vendor saw it on", found({ sources: ["https://copper-harbor.example"] })],
  ];
  fake.reset();
  for (const [label, answer] of offShape) {
    for (const port of [finder, unchecked]) {
      fake.answerNext("findEmail", answer);
      const refused = (error: unknown) =>
        isAppError(error) && error.code === "finder_output_invalid";
      await assert.rejects(port.findEmail(ADA), refused, label);
    }
  }
  const elsewhere = found({ address: "ada@granite-orbit.example", vendorVerdict: "catch_all" });
  fake.answerNext("findEmail", elsewhere);
  assert.deepEqual(await unchecked.findEmail(ADA), elsewhere, "any domain, catch_all as given");
});

test("no name, domain or address in an error, a log line, the console or a metric label; the port's code has no logger and opens no span", async (t) => {
  fake.reset();
  const logs = collectLogs();
  const logger = createLogger({ destination: logs.destination });
  const printed: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    t.mock.method(console, level, (...args: unknown[]) => void printed.push(args));
  const person = {
    firstName: "Quillmarsh",
    lastName: "Tidewater",
    companyDomain: "quillmarsh-tide.example",
  };
  const failing = (code: Parameters<EmailFinderFake["failNext"]>[0]) => () => {
    fake.failNext(code);
    return finder.findEmail(person);
  };
  const calls = [
    () => finder.findEmail(person),
    () => finder.findEmail({ ...person, title: "Quillmarsh lead" } as never),
    () => finder.findEmail({ ...person, firstName: "" }),
    () => finder.findEmail({ ...person, companyDomain: "WWW.QUILLMARSH-TIDE.EXAMPLE" }),
    () => finder.findEmail({ ...person, lastName: "Quillmarsh".repeat(20) }),
    failing("finder_rate_limited"),
    failing("finder_allowance_spent"),
    failing("finder_unauthorized"),
    failing("finder_provider_error"),
    () => {
      const address = "quillmarsh.tidewater@quillmarsh-tide.example";
      fake.answerNext("findEmail", { result: "found", address, vendorVerdict: "quillmarsh" });
      return finder.findEmail(person);
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
    logger.error({ err: error }, "address lookup refused"); // as a host logs a refusal
  }
  assert.deepEqual(
    errors.map((error) => (isAppError(error) ? error.code : error)),
    [
      ...Array(4).fill("finder_input_invalid"),
      "finder_rate_limited",
      "finder_allowance_spent",
      "finder_unauthorized",
      "finder_provider_error",
      "finder_output_invalid",
    ],
  );
  const labels = (recordedMetrics().get("providers.calls") ?? []).filter(
    (l) => l.port === "email_finder",
  );
  assert.ok(labels.length > 0, "the calls were counted");
  const seen = inspect([errors, logs.raw, printed, labels], { depth: Infinity, showHidden: true });
  const values = ["quillmarsh", "tidewater"];
  assert.deepEqual(
    values.filter((value) => seen.toLowerCase().includes(value)),
    [],
  );
  assert.equal(logs.lines().length, errors.length, "the refusals were logged");
  const folder = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.split("/").includes("tests"))
    .map((file) => `${folder}${file}`);
  assert.ok(files.some((file) => file.endsWith("email-finder/port.ts")));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /console\.|createLogger|withSpan|opentelemetry|\blogger\b/, file);
  }
});

test("a live world gets exactly one lookup, of the person it names, every other case skipped; never under APP_ENV=production", async () => {
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
    child.stdout.on("data", (chunk) => void (output += chunk));
    child.stderr.on("data", (chunk) => void (output += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, output };
  };
  const [live, production] = await Promise.all([runAs("test"), runAs("production")]);
  assert.equal(live.code, 0, live.output);
  assert.match(live.output, /live lookups: 1\n/);
  assert.match(live.output, /✔ finds the person the world names, in the port's words/);
  assert.match(live.output, /ℹ pass 2\n/, "the methods, and the one lookup");
  assert.match(live.output, /ℹ skipped 7\n/);
  assert.equal(live.output.match(/# offline only: a live run makes one lookup/g)?.length, 7);
  assert.notEqual(production.code, 0, production.output);
  assert.match(
    production.output,
    /the email-finder live suite is refused under APP_ENV=production/,
  );
  assert.doesNotMatch(production.output, /live lookups/);
});

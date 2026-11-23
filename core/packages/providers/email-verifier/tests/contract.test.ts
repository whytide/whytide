// The port's own tests, and the task's suite on the fake taken from the registry (README.md "The
// contract suite"): PROVIDER_EMAIL_VERIFIER=fake through the config and getAdapters gives the fake,
// on which the contract suite runs; the codes are registered with their statuses and in the README's
// table; an answer off the port's shapes, a sixth verdict among them, is verifier_output_invalid in
// every environment; no address reaches an error, a log line, the console or a metric label, and the
// port opens no span; a live world makes one check and never runs in production. The list at start,
// of several adapters and of an unknown one, is tests/registry.test.ts's. PROVIDER_EMAIL_VERIFIER is
// set before the config is imported, which reads it once.
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
import type { EmailVerifierFake } from "../port.ts";

process.env.PROVIDER_EMAIL_VERIFIER = "fake";
const { bindPort, isFake, registeredAdapters } = await import("../../_pattern/index.ts");
const { getAdapter, getAdapters } = await import("../../registry.ts");
const { contractSuite } = await import("../../testing/index.ts");
const { emailVerifierCases } = await import("../contract.ts");
const { addressWith, fakeWorld } = await import("../fake/tests/world.ts");
const { emailVerifierConfig, emailVerifierPort } = await import("../port.ts");

const listed = await getAdapters(emailVerifierPort, emailVerifierConfig.PROVIDER_EMAIL_VERIFIER);
const [verifier] = listed;
assert.ok(verifier, "PROVIDER_EMAIL_VERIFIER lists the fake");
const fake = verifier as unknown as EmailVerifierFake;
const definition = registeredAdapters(emailVerifierPort).get("fake");
assert.ok(definition, "the registry loaded the fake");
const fakeAdapter = definition as AdapterDefinition<typeof emailVerifierPort>;
contractSuite(emailVerifierPort, fakeAdapter, emailVerifierCases(fakeWorld(fake)));

test("PROVIDER_EMAIL_VERIFIER=fake lists the fake through the config and getAdapters: the instance getAdapter gives, its controls reachable, no allowance", async () => {
  assert.deepEqual(emailVerifierConfig.PROVIDER_EMAIL_VERIFIER, ["fake"]);
  assert.equal(listed.length, 1);
  assert.equal(verifier, await getAdapter(emailVerifierPort, "fake"));
  assert.ok(isFake(verifier));
  assert.equal(verifier.allowance, null);
  assert.equal(emailVerifierPort.variable, "PROVIDER_EMAIL_VERIFIER");
});

test("the codes, with their statuses: the port's four, verifier_allowance_spent the vendor's credits gone, and the pattern's three, each in the README; one method, its outputs checked in every environment", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rows = [...readme.matchAll(/^\| `(verifier_[a-z_]+)` \((\d{3})\) \|/gm)];
  const table = Object.fromEntries(rows.map(([, code, status]) => [code, Number(status)]));
  assert.deepEqual(table, {
    verifier_rate_limited: 429,
    verifier_allowance_spent: 402,
    verifier_unauthorized: 401,
    verifier_provider_error: 502,
  });
  const declared = Object.keys(emailVerifierPort.errors);
  assert.deepEqual(Object.fromEntries(declared.map((code) => [code, httpStatus(code)])), table);
  const own = Object.values(emailVerifierPort.codes);
  assert.deepEqual(
    own.map((code) => [code, httpStatus(code)]),
    [
      ["verifier_input_invalid", 400],
      ["verifier_output_invalid", 500],
      ["verifier_error_unmapped", 500],
    ],
  );
  assert.ok(own.every((code) => readme.includes(`\`${code}\``)));
  // definePort registered them, and a code registered twice would have thrown: no other owner.
  const registered = [...registeredErrors().keys()].filter((code) => code.startsWith("verifier_"));
  assert.deepEqual(registered.toSorted(), [...declared, ...own].toSorted());
  assert.deepEqual(Object.keys(emailVerifierPort.methods), ["verifyEmail"]);
  assert.equal(emailVerifierPort.alwaysCheckOutputs, true);
});

test("an answer off the port's shapes, a sixth verdict among them, is verifier_output_invalid, though a binding asks for no check, as production's do", async () => {
  // The fake itself, bound as production binds an adapter: no check asked for.
  const unchecked = bindPort(emailVerifierPort, fakeAdapter.create(), {
    adapter: "fake",
    checkOutputs: false,
  });
  const now = new Date();
  const offShape: readonly (readonly [label: string, answer: unknown])[] = [
    ["nothing", undefined],
    ["null", null],
    ["no verdict", { checkedAt: now }],
    ["no time", { verdict: "valid" }],
    ["a sixth verdict", { verdict: "deliverable", checkedAt: now }],
    ["accept-all in the vendor's words", { verdict: "accept_all", checkedAt: now }],
    ["a verdict in capitals", { verdict: "VALID", checkedAt: now }],
    ["a time in text", { verdict: "valid", checkedAt: now.toISOString() }],
    ["a time in milliseconds", { verdict: "valid", checkedAt: now.getTime() }],
    ["a field the port does not declare", { verdict: "valid", checkedAt: now, score: 97 }],
    ["the address given back", { verdict: "valid", checkedAt: now, address: addressWith("valid") }],
  ];
  const address = addressWith("valid");
  fake.reset();
  for (const [label, answer] of offShape) {
    for (const port of [verifier, unchecked]) {
      fake.answerNext("verifyEmail", answer);
      const refused = (error: unknown) =>
        isAppError(error) && error.code === "verifier_output_invalid";
      await assert.rejects(port.verifyEmail({ address }), refused, label);
    }
  }
  const valid = { verdict: "catch_all", checkedAt: now };
  fake.answerNext("verifyEmail", valid);
  assert.deepEqual(await unchecked.verifyEmail({ address }), valid, "catch_all stays catch_all");
});

test("no address in an error, a log line, the console or a metric label; the port's code has no logger and opens no span", async (t) => {
  fake.reset();
  const logs = collectLogs();
  const logger = createLogger({ destination: logs.destination });
  const printed: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    t.mock.method(console, level, (...args: unknown[]) => void printed.push(args));
  const address = "quillmarsh.ada@quillmarsh-tide.example";
  const failing = (code: Parameters<EmailVerifierFake["failNext"]>[0]) => () => {
    fake.failNext(code);
    return verifier.verifyEmail({ address });
  };
  const calls = [
    () => verifier.verifyEmail({ address }),
    () => verifier.verifyEmail({ address, firstName: "Quillmarsh" } as never),
    () => verifier.verifyEmail({ address: address.toUpperCase() }),
    () => verifier.verifyEmail({ address: `Quillmarsh Ada <${address}>` }),
    failing("verifier_rate_limited"),
    failing("verifier_allowance_spent"),
    failing("verifier_unauthorized"),
    failing("verifier_provider_error"),
    () => {
      fake.answerNext("verifyEmail", { verdict: "valid", checkedAt: new Date(), address });
      return verifier.verifyEmail({ address });
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
    logger.error({ err: error }, "address check refused"); // as a host logs a refusal
  }
  assert.deepEqual(
    errors.map((error) => (isAppError(error) ? error.code : error)),
    [
      ...Array(3).fill("verifier_input_invalid"),
      "verifier_rate_limited",
      "verifier_allowance_spent",
      "verifier_unauthorized",
      "verifier_provider_error",
      "verifier_output_invalid",
    ],
  );
  const labels = (recordedMetrics().get("providers.calls") ?? []).filter(
    (l) => l.port === "email_verifier",
  );
  assert.ok(labels.length > 0, "the calls were counted");
  const seen = inspect([errors, logs.raw, printed, labels], { depth: Infinity, showHidden: true });
  assert.equal(seen.toLowerCase().includes("quillmarsh"), false, "no part of the address");
  assert.equal(logs.lines().length, errors.length, "the refusals were logged");
  const folder = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.split("/").includes("tests"))
    .map((file) => `${folder}${file}`);
  assert.ok(files.some((file) => file.endsWith("email-verifier/port.ts")));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /console\.|createLogger|withSpan|opentelemetry|\blogger\b/, file);
  }
});

test("a live world gets exactly one check, of the address it names, every other case skipped; never under APP_ENV=production", async () => {
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
  assert.match(live.output, /live checks: 1\n/);
  assert.match(live.output, /✔ checks the address the world names, in the port's words/);
  assert.match(live.output, /ℹ pass 2\n/, "the methods, and the one check");
  assert.match(live.output, /ℹ skipped 6\n/);
  assert.equal(live.output.match(/# offline only: a live run makes one check/g)?.length, 6);
  assert.notEqual(production.code, 0, production.output);
  assert.match(
    production.output,
    /the email-verifier live suite is refused under APP_ENV=production/,
  );
  assert.doesNotMatch(production.output, /live checks/);
});

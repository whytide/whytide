// The end-to-end test of alpha-p1-090: the package used as a consumer module and an adapter task use
// it. The fixture port (fixtures/pattern/fixture) with a fake and two more adapters runs the same
// contract suite through the test runner, each from its <adapter>/tests/contract.test.ts; a broken
// adapter fails it with the method's name; a suite without its credentials is skipped and exits 0.
// The registry resolves PROVIDER_FIXTURE; the boundary parses inputs, wraps an unmapped error
// everywhere and, in test mode, refuses a vendor field and a transform; the fake records and fails on
// demand; provider_refs takes vendor ids.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defineConfig, isAppError, throwsCode } from "@whytide/platform";
import { z } from "zod";
import {
  bindPort,
  createFake,
  defineAdapter,
  definePort,
  getAdapter,
  isFake,
  providerSelector,
  setProviderRef,
} from "../index.ts";
import { greeter } from "./fixtures/pattern/fixture/echo/index.ts";
import { fixtureFake } from "./fixtures/pattern/fixture/fake/index.ts";
import { fixturePort } from "./fixtures/pattern/fixture/port.ts";

const fixtureDir = new URL("./fixtures/pattern/fixture/", import.meta.url);

/** Runs fixture test files through `node --test`, as `pnpm test:contract` runs the adapters'. */
async function runTestFiles(names: string[], env: NodeJS.ProcessEnv = process.env) {
  const files = names.map((name) => fileURLToPath(new URL(name, fixtureDir)));
  const reporter = ["--test-reporter=spec", "--test-reporter-destination=stdout"];
  // Without the test runner's own marker, or the child refuses to run a test file inside a test.
  const { NODE_TEST_CONTEXT: _context, ...childEnv } = env;
  const child = spawn(process.execPath, ["--test", ...reporter, ...files], {
    env: childEnv,
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
}

test("the fake and two more adapters pass the same contract suite, each from its tests/contract.test.ts", async () => {
  const run = await runTestFiles([
    "fake/tests/contract.test.ts",
    "echo/tests/contract.test.ts",
    "lazy/tests/contract.test.ts",
  ]);
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /✔ fixture contract: fake/);
  assert.match(run.output, /✔ fixture contract: echo/);
  assert.match(run.output, /✔ fixture contract: lazy/);
  assert.match(run.output, /ℹ pass 15\n/);
  assert.match(run.output, /ℹ fail 0\n/);
});

test("a deliberately broken adapter fails the suite with the method's name", async () => {
  const run = await runTestFiles(["broken/tests/contract.test.ts"]);
  assert.equal(run.code, 1, run.output);
  assert.match(run.output, /✖ fixture contract: broken/);
  assert.match(run.output, /fixture_output_invalid/);
  assert.match(run.output, /method: 'greet'/);
  assert.match(run.output, /path: 'vendor_id'/);
});

test("a contract suite with missing credentials reports skipped and exits 0", async () => {
  const env = { ...process.env };
  delete env.FIXTURE_API_KEY;
  const run = await runTestFiles(["needs-key/tests/contract.test.ts"], env);
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /fixture contract: needs-key/);
  assert.match(run.output, /﹣ skipped: no credentials \(FIXTURE_API_KEY\) .*# SKIP/);
  assert.match(run.output, /ℹ pass 0\n/);
  assert.match(run.output, /ℹ fail 0\n/);
  assert.match(run.output, /ℹ skipped 1\n/);
});

test("getAdapter: PROVIDER_FIXTURE=fake returns the fake; an unknown name fails at start, listing the known ones", async () => {
  const shape = { PROVIDER_FIXTURE: providerSelector() };
  const config = defineConfig("packages/providers", shape, { PROVIDER_FIXTURE: "fake" });
  const fixture = await getAdapter(fixturePort, config.PROVIDER_FIXTURE);
  assert.ok(isFake(fixture));
  assert.equal(fixture, await getAdapter(fixturePort, "fake"));
  await assert.rejects(getAdapter(fixturePort, "nope"), (error: unknown) => {
    assert.ok(isAppError(error) && error.code === "provider_unknown");
    assert.deepEqual(error.details, {
      port: "fixture",
      selector: "nope",
      known: ["echo", "fake"],
    });
    return true;
  });
  await assert.rejects(getAdapter(fixturePort, undefined), (error: unknown) => {
    assert.ok(isAppError(error) && error.code === "provider_not_configured");
    assert.deepEqual(error.details, { port: "fixture", variable: "PROVIDER_FIXTURE" });
    return true;
  });
  throwsCode(
    () => defineConfig("packages/providers", shape, { PROVIDER_FIXTURE: "Not A Folder" }),
    "config_invalid",
  );
});

test("the boundary: the input parsed; in test mode a vendor field, a vendor object, a wrong type and a transform refused", async () => {
  const fixture = await getAdapter(fixturePort, "fake");
  fixtureFake.reset();
  assert.deepEqual(await fixture.greet({ name: "Ada" }), { greeting: "hello Ada" });
  assert.deepEqual(fixtureFake.recordedCalls, [
    { method: "greet", input: { name: "Ada", shout: false } },
  ]);
  await assert.rejects(fixture.greet({ name: "" }), (error: unknown) => {
    assert.ok(isAppError(error) && error.code === "fixture_input_invalid");
    assert.equal(error.status, 400);
    assert.deepEqual(error.details, {
      method: "greet",
      issues: ["name: Too small: expected string to have >=1 characters"],
    });
    return true;
  });
  await assert.rejects(
    fixture.greet({ name: "nobody" }),
    (error: unknown) => isAppError(error) && error.code === "fixture_not_found",
  );

  const vendorShaped = {
    ...greeter(),
    greet: async ({ name }: { name: string }) => ({
      greeting: `hello ${name}`,
      vendor_id: "grt_1",
    }),
  };
  const leaking = bindPort(fixturePort, vendorShaped, { adapter: "leaking" });
  await assert.rejects(leaking.greet({ name: "Ada" }), (error: unknown) => {
    assert.ok(isAppError(error) && error.code === "fixture_output_invalid");
    assert.equal(error.status, 500);
    assert.deepEqual(error.details, {
      method: "greet",
      path: "vendor_id",
      reason: "a field the port does not declare",
    });
    return true;
  });
  const production = bindPort(fixturePort, vendorShaped, { adapter: "leaking", validate: false });
  assert.deepEqual(await production.greet({ name: "Ada" }), {
    greeting: "hello Ada",
    vendor_id: "grt_1",
  });

  // A vendor SDK's response object: a class instance, its fields own keys, walked like a plain object.
  class VendorGreeting {
    readonly greeting: string;
    readonly email: string;
    constructor(greeting: string, email: string) {
      this.greeting = greeting;
      this.email = email;
    }
  }
  const instanceShaped = {
    ...greeter(),
    greet: async ({ name }: { name: string }) =>
      new VendorGreeting(`hello ${name}`, "ada@example.com"),
  };
  await assert.rejects(
    bindPort(fixturePort, instanceShaped, { adapter: "instance" }).greet({ name: "Ada" }),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "fixture_output_invalid");
      assert.deepEqual(error.details, {
        method: "greet",
        path: "email",
        reason: "a field the port does not declare",
      });
      return true;
    },
  );

  const wrongType = {
    ...greeter(),
    count: async () => ({ greetings: "many" as unknown as number }),
  };
  await assert.rejects(
    bindPort(fixturePort, wrongType, { adapter: "wrong-type" }).count(),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "fixture_output_invalid");
      assert.deepEqual(error.details, {
        method: "count",
        issues: ["greetings: Invalid input: expected number, received string"],
      });
      return true;
    },
  );

  // An output schema that rewrites its value: the port's fault, named as such.
  const trimmerPort = definePort({
    name: "trimmer",
    methods: { trim: { input: z.void(), output: z.object({ text: z.string().trim() }) } },
    errors: {},
  });
  const trimmer = bindPort(
    trimmerPort,
    { trim: async () => ({ text: " padded " }) },
    {
      adapter: "padding",
    },
  );
  await assert.rejects(trimmer.trim(), (error: unknown) => {
    assert.ok(isAppError(error) && error.code === "trimmer_output_invalid");
    assert.deepEqual(error.details, {
      method: "trim",
      path: "text",
      reason: "the schema transforms",
    });
    return true;
  });
});

test("an unmapped vendor error is wrapped in every environment; its payload travels as the cause in test mode only", async () => {
  const vendorError = {
    ...greeter(),
    greet: async () => {
      throw Object.assign(new Error("socket hang up while sending ada@example.com"), {
        code: "ECONNRESET",
      });
    },
  };
  await assert.rejects(
    bindPort(fixturePort, vendorError, { adapter: "vendor-error" }).greet({ name: "Ada" }),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "fixture_error_unmapped");
      assert.equal(error.status, 500);
      assert.deepEqual(error.details, { method: "greet", code: "ECONNRESET" });
      assert.ok(error.cause instanceof Error && error.cause.message.startsWith("socket hang up"));
      return true;
    },
  );
  const production = bindPort(fixturePort, vendorError, {
    adapter: "vendor-error",
    validate: false,
  });
  await assert.rejects(production.greet({ name: "Ada" }), (error: unknown) => {
    assert.ok(isAppError(error) && error.code === "fixture_error_unmapped");
    assert.deepEqual(error.details, { method: "greet", code: "ECONNRESET" });
    assert.equal(error.cause, undefined);
    assert.equal(error.message, "fixture_error_unmapped");
    return true;
  });

  // Without a code, the error's name or status; a message, whatever it is, never.
  class RateLimitError extends Error {
    readonly status = 429;
  }
  const statusOnly = {
    ...greeter(),
    greet: async () => {
      throw Object.assign(new RateLimitError("429 Too Many Requests: slow down"), { name: "" });
    },
  };
  await assert.rejects(
    bindPort(fixturePort, statusOnly, { adapter: "status-only", validate: false }).greet({
      name: "Ada",
    }),
    (error: unknown) => {
      assert.ok(isAppError(error));
      assert.deepEqual(error.details, { method: "greet", code: 429 });
      return true;
    },
  );
  const notAnError = {
    ...greeter(),
    greet: async () => {
      throw "the vendor rejected the call";
    },
  };
  await assert.rejects(
    bindPort(fixturePort, notAnError, { adapter: "string-thrower", validate: false }).greet({
      name: "Ada",
    }),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "fixture_error_unmapped");
      assert.deepEqual(error.details, { method: "greet", code: undefined });
      return true;
    },
  );
});

test("the fake records every call, fails the next one on demand and resets", async () => {
  const fixture = await getAdapter(fixturePort, "fake");
  fixtureFake.reset();
  fixtureFake.failNext("fixture_rate_limited", { retryAfterSec: 30 });
  await assert.rejects(fixture.count(), (error: unknown) => {
    assert.ok(isAppError(error) && error.code === "fixture_rate_limited");
    assert.equal(error.status, 429);
    assert.deepEqual(error.details, { retryAfterSec: 30 });
    return true;
  });
  assert.deepEqual(await fixture.count(), { greetings: 0 });
  await fixture.greet({ name: "Ada" });
  fixtureFake.record("model.generate", { prompt: "hello" });
  assert.deepEqual(
    fixtureFake.recordedCalls.map((call) => call.method),
    ["count", "count", "greet", "model.generate"],
  );
  assert.deepEqual(fixtureFake.greeted(), ["Ada"]);
  assert.deepEqual(fixtureFake.state.greeted, ["Ada"]);
  fixtureFake.reset();
  assert.deepEqual(fixtureFake.recordedCalls, []);
  assert.deepEqual(await fixture.count(), { greetings: 0 });
  throwsCode(() => fixtureFake.failNext("llm_rate_limited" as never), "adapter_invalid");
  throwsCode(() => fixtureFake.failNext("constructor" as never), "adapter_invalid");
  assert.throws(
    () =>
      createFake(fixturePort, {
        state: () => ({}),
        methods: () => ({ ...greeter(), sendMessage: async () => ({}) }),
      }),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "adapter_invalid");
      assert.deepEqual(error.details, {
        port: "fixture",
        adapter: "fake",
        reason: "a method the port does not declare",
        extra: ["sendMessage"],
      });
      return true;
    },
  );
});

test("the shape check: every port method, nothing the port does not declare, a fake's controls aside", () => {
  const chatty = { ...greeter(), sendMessage: async () => ({}) };
  assert.throws(
    () => bindPort(fixturePort, chatty, { adapter: "chatty" }),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "port_shape_mismatch");
      assert.deepEqual(error.details, {
        port: "fixture",
        adapter: "chatty",
        missing: [],
        extra: ["sendMessage"],
      });
      return true;
    },
  );
  const { count: _count, ...partial } = greeter();
  assert.throws(
    () => bindPort(fixturePort, partial as never, { adapter: "partial" }),
    (error: unknown) =>
      isAppError(error) &&
      error.code === "port_shape_mismatch" &&
      (error.details as { missing: string[] }).missing.join() === "count",
  );
  assert.deepEqual(Object.keys(bindPort(fixturePort, greeter(), { adapter: "echo" })), [
    "greet",
    "count",
  ]);
});

test("definitions are checked at start: the name, the <port>_ prefix, a fake's control names, duplicates", () => {
  const methods = { ping: { input: z.void(), output: z.object({ ok: z.literal(true) }) } };
  throwsCode(() => definePort({ name: "Fixture", methods, errors: {} }), "port_invalid");
  throwsCode(() => definePort({ name: "fixture", methods, errors: {} }), "duplicate_port");
  throwsCode(() => definePort({ name: "pinger", methods: {}, errors: {} }), "port_invalid");
  throwsCode(
    () => definePort({ name: "pinger", methods, errors: { rate_limited: {} } }),
    "port_invalid",
  );
  assert.throws(
    () => definePort({ name: "pinger", methods: { ...methods, reset: methods.ping }, errors: {} }),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "port_invalid");
      assert.deepEqual(error.details, {
        port: "pinger",
        reason: "a method is named like a fake's control",
        method: "reset",
      });
      return true;
    },
  );
  for (const method of ["record", "state", "recordedCalls", "failNext"]) {
    throwsCode(
      () => definePort({ name: "pinger", methods: { [method]: methods.ping }, errors: {} }),
      "port_invalid",
    );
  }
  // The real app_mail port holds the `mail` prefix now (alpha-p1-110): a second one would be a duplicate code.
  const mail = definePort({
    name: "app_mail_fixture",
    errorPrefix: "fixture_mail",
    methods,
    errors: { fixture_mail_rejected: {} },
  });
  assert.equal(mail.variable, "PROVIDER_APP_MAIL_FIXTURE");
  assert.equal(mail.errors.fixture_mail_rejected, "fixture_mail_rejected");
  assert.deepEqual(mail.codes, {
    input: "fixture_mail_input_invalid",
    output: "fixture_mail_output_invalid",
    error: "fixture_mail_error_unmapped",
  });
  throwsCode(
    () => defineAdapter(fixturePort, { name: "fake", create: greeter }),
    "duplicate_adapter",
  );
  throwsCode(
    () => defineAdapter(fixturePort, { name: "Fake", create: greeter }),
    "adapter_invalid",
  );
});

test("setProviderRef keeps a vendor's id in provider_refs, keyed by adapter name", () => {
  const row = { id: "sacc_1", providerRefs: null };
  const once = setProviderRef(row, "unipile", "acc_123");
  assert.deepEqual(once, { id: "sacc_1", providerRefs: { unipile: "acc_123" } });
  assert.deepEqual(setProviderRef(once, "fake", "f_1").providerRefs, {
    unipile: "acc_123",
    fake: "f_1",
  });
  assert.equal(row.providerRefs, null);
  throwsCode(() => setProviderRef(row, "unipile", ""), "provider_ref_invalid");
  throwsCode(() => setProviderRef(row, "Unipile", "acc_1"), "provider_ref_invalid");
  throwsCode(
    () => setProviderRef({ providerRefs: "acc_123" }, "unipile", "x"),
    "provider_ref_invalid",
  );
});

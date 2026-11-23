// The port's own tests, and the task's suite on the fake taken from the registry (README.md "The
// contract suite"): PROVIDER_BROWSER=fake through the config and getAdapter gives the fake, on which
// the contract suite runs; an unknown name fails at start and an empty one binds nothing; the codes
// are registered with their statuses and in the README's table; an answer off the port's shapes is
// browser_output_invalid in every environment; no URL's path or query and no page's text reaches an
// error, a log line, the console or a metric label, and the port's code has no log or span of its
// own. PROVIDER_BROWSER is set before the config is imported, which reads it once.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import type { BrowserFake } from "../port.ts";

process.env.PROVIDER_BROWSER = "fake";
const { bindPort, isFake, registeredAdapters } = await import("../../_pattern/index.ts");
const { getAdapter } = await import("../../registry.ts");
const { contractSuite } = await import("../../testing/index.ts");
const { browserCases } = await import("../contract.ts");
const { fakeWorld, PAGE, PAGE_URL } = await import("../fake/tests/world.ts");
const { browserConfig, browserPort } = await import("../port.ts");

const browser = await getAdapter(browserPort, browserConfig.PROVIDER_BROWSER);
const fake = browser as unknown as BrowserFake;
const definition = registeredAdapters(browserPort).get("fake");
assert.ok(definition, "the registry loaded the fake");
const fakeAdapter = definition as AdapterDefinition<typeof browserPort>;
contractSuite(browserPort, fakeAdapter, browserCases(fakeWorld(fake)));

test("PROVIDER_BROWSER=fake gives the fake through the config and getAdapter, its controls reachable", async () => {
  assert.equal(browserConfig.PROVIDER_BROWSER, "fake");
  assert.ok(isFake(browser));
  assert.equal(browser, await getAdapter(browserPort, "fake"));
  assert.equal(browserPort.variable, "PROVIDER_BROWSER");
});

test("PROVIDER_BROWSER at start: an adapter the registry does not know or a name that is no folder name fails; empty binds nothing", async () => {
  const registry = JSON.stringify(import.meta.resolve("../../registry.ts"));
  const port = JSON.stringify(import.meta.resolve("../port.ts"));
  const script = [
    "try {",
    `  const { browserConfig, browserPort } = await import(${port});`,
    `  const { getAdapter } = await import(${registry});`,
    "  await getAdapter(browserPort, browserConfig.PROVIDER_BROWSER);",
    "  console.log('started');",
    "} catch (error) { console.log(error.code); }",
  ].join("\n");
  const startWith = (PROVIDER_BROWSER: string) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APP_ENV: "test", PROVIDER_BROWSER },
    }).then(({ stdout }) => `${PROVIDER_BROWSER}: ${stdout.trim()}`);
  assert.deepEqual(await Promise.all(["fake", "", "no-such-vendor", "Fake"].map(startWith)), [
    "fake: started",
    ": provider_not_configured",
    "no-such-vendor: provider_unknown",
    "Fake: config_invalid",
  ]);
});

test("the codes, with their statuses: the port's five and the pattern's three, each in the README; one method, its outputs checked in every environment", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rows = [...readme.matchAll(/^\| `(browser_[a-z_]+)` \((\d{3})\) \|/gm)];
  const table = Object.fromEntries(rows.map(([, code, status]) => [code, Number(status)]));
  assert.deepEqual(table, {
    browser_blocked: 403,
    browser_timeout: 504,
    browser_too_large: 413,
    browser_unavailable: 503,
    browser_provider_error: 502,
  });
  const declared = Object.keys(browserPort.errors);
  assert.deepEqual(Object.fromEntries(declared.map((code) => [code, httpStatus(code)])), table);
  const own = Object.values(browserPort.codes);
  assert.deepEqual(
    own.map((code) => [code, httpStatus(code)]),
    [
      ["browser_input_invalid", 400],
      ["browser_output_invalid", 500],
      ["browser_error_unmapped", 500],
    ],
  );
  assert.ok(own.every((code) => readme.includes(`\`${code}\``)));
  const registered = [...registeredErrors().keys()].filter((code) => code.startsWith("browser_"));
  assert.deepEqual(registered.toSorted(), [...declared, ...own].toSorted());
  assert.deepEqual(Object.keys(browserPort.methods), ["renderPage"]);
  assert.equal(browserPort.alwaysCheckOutputs, true);
});

test("an answer off the port's shapes is browser_output_invalid, though a binding asks for no check, as production's do", async () => {
  const unchecked = bindPort(browserPort, fakeAdapter.create(), {
    adapter: "fake",
    checkOutputs: false,
  });
  const page = (fields: Record<string, unknown>) => ({ ...PAGE, ...fields });
  const link = (fields: Record<string, unknown>) =>
    page({ links: [{ href: "https://example.test/about", text: "About", ...fields }] });
  const offShape: readonly (readonly [label: string, answer: unknown])[] = [
    ["nothing", undefined],
    ["null", null],
    ["no links", { finalUrl: PAGE.finalUrl, status: 200, text: "" }],
    ["the page's HTML", page({ html: "<p>Copper</p>" })],
    ["a screenshot", page({ screenshot: "iVBORw0KGgo=" })],
    ["the page's cookies", page({ cookies: [] })],
    ["text past 50,000 characters", page({ text: "x".repeat(50_001) })],
    [
      "301 links",
      page({
        links: Array.from({ length: 301 }, (_, n) => ({ href: `https://a.test/${n}`, text: "" })),
      }),
    ],
    ["a relative link", link({ href: "/about" })],
    ["a javascript: link", link({ href: "javascript:void(0)" })],
    ["a file: link", link({ href: "file:///etc/passwd" })],
    ["a link's text past 200 characters", link({ text: "x".repeat(201) })],
    ["a link's field the port does not declare", link({ rel: "nofollow" })],
    ["a final URL on file:", page({ finalUrl: "file:///etc/passwd" })],
    ["a final URL past 2,048 characters", page({ finalUrl: `https://a.test/${"a".repeat(2048)}` })],
    ["a final URL the schema would trim", page({ finalUrl: ` ${PAGE.finalUrl}` })],
    ["status 0", page({ status: 0 })],
    ["status 600", page({ status: 600 })],
    ["a status in text", page({ status: "200" })],
  ];
  const request = { url: PAGE_URL };
  fake.reset();
  for (const [label, answer] of offShape) {
    for (const port of [browser, unchecked]) {
      fake.answerNext("renderPage", answer);
      const refused = (error: unknown) =>
        isAppError(error) && error.code === "browser_output_invalid";
      await assert.rejects(port.renderPage(request), refused, label);
    }
  }
  const valid = page({ links: [], text: "", status: 404 });
  fake.answerNext("renderPage", valid);
  assert.deepEqual(await unchecked.renderPage(request), valid, "an empty page and a 404");
});

test("no URL's path or query and no page's text in an error, a log line, the console or a metric label; the port's code has no log or span of its own", async (t) => {
  fake.reset();
  const logs = collectLogs();
  const logger = createLogger({ destination: logs.destination });
  const printed: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    t.mock.method(console, level, (...args: unknown[]) => void printed.push(args));
  const url = "https://copper-harbor.example/quillmarsh-team?ref=quillmarsh-tide";
  const text = "Quillmarsh Tide, our harbour master";
  fake.seedPage(url, { text, links: [{ href: `${url}#crew`, text }] });
  const failing = (code: Parameters<BrowserFake["failNext"]>[0]) => () => {
    fake.failNext(code);
    return browser.renderPage({ url });
  };
  const calls = [
    () => browser.renderPage({ url }),
    () => browser.renderPage({ url: url.replace("copper-harbor", "elsewhere") }),
    () => browser.renderPage({ url: url.replace("https:", "file:") }),
    () => browser.renderPage({ url: "copper-harbor.example/quillmarsh-team?ref=quillmarsh" }),
    () => browser.renderPage({ url: `${url}&q=${"quillmarsh".repeat(250)}` }),
    failing("browser_blocked"),
    failing("browser_timeout"),
    failing("browser_too_large"),
    failing("browser_unavailable"),
    failing("browser_provider_error"),
    () => {
      fake.answerNext("renderPage", { ...PAGE, text: text.repeat(2_000) });
      return browser.renderPage({ url });
    },
    () => {
      fake.answerNext("renderPage", { ...PAGE, links: [{ href: `${url}#a`, text, title: text }] });
      return browser.renderPage({ url });
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
    logger.error({ err: error }, "page render refused"); // as a caller logs a refusal
  }
  assert.deepEqual(
    errors.map((error) => (isAppError(error) ? error.code : error)),
    [
      "browser_blocked",
      "browser_blocked",
      "browser_input_invalid",
      "browser_input_invalid",
      "browser_blocked",
      "browser_timeout",
      "browser_too_large",
      "browser_unavailable",
      "browser_provider_error",
      "browser_output_invalid",
      "browser_output_invalid",
    ],
  );
  const labels = (recordedMetrics().get("providers.calls") ?? []).filter(
    (label) => label.port === "browser",
  );
  assert.ok(labels.length > 0, "the calls were counted");
  const seen = inspect([errors, logs.raw, printed, labels], { depth: Infinity, showHidden: true });
  assert.equal(seen.toLowerCase().includes("quillmarsh"), false, seen);
  assert.equal(logs.lines().length, errors.length, "the refusals were logged");
  const folder = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.split("/").includes("tests"))
    .map((file) => `${folder}${file}`);
  for (const expected of [
    "browser/port.ts",
    "browser/fake/index.ts",
    "browser/playwright/index.ts",
  ]) {
    assert.ok(
      files.some((file) => file.endsWith(expected)),
      `${expected} in ${files.join()}`,
    );
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /console\.|createLogger|withSpan|opentelemetry|\blogger\b/, file);
  }
});

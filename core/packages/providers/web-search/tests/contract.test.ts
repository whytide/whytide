// The port's own tests, and the task's suite on the fake taken from the registry (README.md "The
// contract suite"): PROVIDER_WEB_SEARCH=fake through the config and getAdapters gives the fake, on
// which the contract suite runs; any other list fails at start, an empty one lists none; the codes
// are registered with their statuses and in the README's table; an answer off the port's shapes is
// web_search_output_invalid in every environment; no query reaches an error, a log line, the console
// or a metric label, and the port opens no span; a live world makes one search and never runs in
// production. PROVIDER_WEB_SEARCH is set before the config is imported, which reads it once.
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
import type { WebSearchFake } from "../port.ts";

process.env.PROVIDER_WEB_SEARCH = "fake";
const { bindPort, isFake, registeredAdapters } = await import("../../_pattern/index.ts");
const { getAdapter, getAdapters } = await import("../../registry.ts");
const { contractSuite } = await import("../../testing/index.ts");
const { webSearchCases } = await import("../contract.ts");
const { fakeWorld, QUERY, RESULTS } = await import("../fake/tests/world.ts");
const { webSearchConfig, webSearchPort } = await import("../port.ts");

const listed = await getAdapters(webSearchPort, webSearchConfig.PROVIDER_WEB_SEARCH);
const [webSearch] = listed;
assert.ok(webSearch, "PROVIDER_WEB_SEARCH lists the fake");
const fake = webSearch as unknown as WebSearchFake;
const definition = registeredAdapters(webSearchPort).get("fake");
assert.ok(definition, "the registry loaded the fake");
const fakeAdapter = definition as AdapterDefinition<typeof webSearchPort>;
contractSuite(webSearchPort, fakeAdapter, webSearchCases(fakeWorld(fake)));

test("PROVIDER_WEB_SEARCH=fake lists the fake through the config and getAdapters: the instance getAdapter gives, its controls reachable, no allowance", async () => {
  assert.deepEqual(webSearchConfig.PROVIDER_WEB_SEARCH, ["fake"]);
  assert.equal(listed.length, 1);
  assert.equal(webSearch, await getAdapter(webSearchPort, "fake"));
  assert.ok(isFake(webSearch));
  assert.deepEqual([webSearch.allowance, webSearch.openData], [null, false]);
  assert.equal(webSearchPort.variable, "PROVIDER_WEB_SEARCH");
});

test("PROVIDER_WEB_SEARCH at start: an adapter the registry does not know, one named twice or a name that is no folder name fails; empty lists none", async () => {
  const registry = JSON.stringify(import.meta.resolve("../../registry.ts"));
  const port = JSON.stringify(import.meta.resolve("../port.ts"));
  const script = [
    "try {",
    `  const { webSearchConfig, webSearchPort } = await import(${port});`,
    `  const { getAdapters } = await import(${registry});`,
    "  const listed = await getAdapters(webSearchPort, webSearchConfig.PROVIDER_WEB_SEARCH);",
    "  console.log(`started with ${listed.length}`);",
    "} catch (error) { console.log(error.code); }",
  ].join("\n");
  const startWith = (PROVIDER_WEB_SEARCH: string) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APP_ENV: "test", PROVIDER_WEB_SEARCH },
    }).then(({ stdout }) => `${PROVIDER_WEB_SEARCH}: ${stdout.trim()}`);
  const lists = ["fake", "", "fake,no-such-vendor", "fake,fake", "Brave"];
  assert.deepEqual(await Promise.all(lists.map(startWith)), [
    "fake: started with 1",
    ": started with 0",
    "fake,no-such-vendor: provider_unknown",
    "fake,fake: config_invalid",
    "Brave: config_invalid",
  ]);
});

test("the codes, with their statuses: the port's four and the pattern's three, each in the README; one method, its outputs checked in every environment", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rows = [...readme.matchAll(/^\| `(web_search_[a-z_]+)` \((\d{3})\) \|/gm)];
  const table = Object.fromEntries(rows.map(([, code, status]) => [code, Number(status)]));
  assert.deepEqual(table, {
    web_search_rate_limited: 429,
    web_search_allowance_spent: 402,
    web_search_unauthorized: 401,
    web_search_provider_error: 502,
  });
  const declared = Object.keys(webSearchPort.errors);
  assert.deepEqual(Object.fromEntries(declared.map((code) => [code, httpStatus(code)])), table);
  const own = Object.values(webSearchPort.codes);
  assert.deepEqual(
    own.map((code) => [code, httpStatus(code)]),
    [
      ["web_search_input_invalid", 400],
      ["web_search_output_invalid", 500],
      ["web_search_error_unmapped", 500],
    ],
  );
  assert.ok(own.every((code) => readme.includes(`\`${code}\``)));
  const registered = [...registeredErrors().keys()].filter((code) =>
    code.startsWith("web_search_"),
  );
  assert.deepEqual(registered.toSorted(), [...declared, ...own].toSorted());
  assert.deepEqual(Object.keys(webSearchPort.methods), ["searchWeb"]);
  assert.equal(webSearchPort.alwaysCheckOutputs, true);
});

test("an answer off the port's shapes is web_search_output_invalid, though a binding asks for no check, as production's do", async () => {
  const unchecked = bindPort(webSearchPort, fakeAdapter.create(), {
    adapter: "fake",
    checkOutputs: false,
  });
  const [first] = RESULTS;
  assert.ok(first);
  const one = (result: Record<string, unknown>) => ({ results: [{ ...first, ...result }] });
  const offShape: readonly (readonly [label: string, answer: unknown])[] = [
    ["nothing", undefined],
    ["no results", {}],
    ["results not a list", { results: first }],
    ["a field the port does not declare", { results: [], total: 3 }],
    ["more results than the most", { results: Array(11).fill(first) }],
    ["a result's field the port does not declare", one({ rank: 1 })],
    ["a person's field", one({ authorName: "Ada Example" })],
    ["a link over http", one({ url: "http://copper-harbor.example/" })],
    ["a link that is no URL", one({ url: "copper-harbor.example" })],
    ["a link too long", one({ url: `https://copper-harbor.example/${"x".repeat(2048)}` })],
    ["no title", { results: [{ url: first.url, snippet: "" }] }],
    ["a title too long", one({ title: "x".repeat(301) })],
    ["a snippet too long", one({ snippet: "x".repeat(301) })],
    ["a snippet in pieces", one({ snippet: ["Copper", "Harbor"] })],
  ];
  const search = { query: QUERY, count: 3 };
  fake.reset();
  for (const [label, answer] of offShape) {
    for (const port of [webSearch, unchecked]) {
      fake.answerNext("searchWeb", answer);
      const refused = (error: unknown) =>
        isAppError(error) && error.code === "web_search_output_invalid";
      await assert.rejects(port.searchWeb(search), refused, label);
    }
  }
  fake.answerNext("searchWeb", { results: [] });
  assert.deepEqual(await unchecked.searchWeb(search), { results: [] }, "none is an answer");
});

test("no query or site in an error, a log line, the console or a metric label; the port's code has no logger and opens no span", async (t) => {
  fake.reset();
  const logs = collectLogs();
  const logger = createLogger({ destination: logs.destination });
  const printed: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    t.mock.method(console, level, (...args: unknown[]) => void printed.push(args));
  const query = "Quillmarsh Tide Holdings official website";
  const site = "quillmarsh-tide.example";
  fake.seedResults(query, RESULTS);
  const failing = (code: Parameters<WebSearchFake["failNext"]>[0]) => () => {
    fake.failNext(code);
    return webSearch.searchWeb({ query, site, count: 3 });
  };
  const calls = [
    () => webSearch.searchWeb({ query, count: 3 }),
    () => webSearch.searchWeb({ query, count: 30 }),
    () => webSearch.searchWeb({ query, site: site.toUpperCase(), count: 3 }),
    () => webSearch.searchWeb({ query: `${query} `.repeat(10), count: 3 }),
    () => webSearch.searchWeb({ query, count: 3, firstName: "Quillmarsh" } as never),
    failing("web_search_rate_limited"),
    failing("web_search_allowance_spent"),
    failing("web_search_unauthorized"),
    failing("web_search_provider_error"),
    () => {
      fake.answerNext("searchWeb", { results: [], query });
      return webSearch.searchWeb({ query, count: 3 });
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
    logger.error({ err: error }, "web search refused"); // as a host logs a refusal
  }
  assert.deepEqual(
    errors.map((error) => (isAppError(error) ? error.code : error)),
    [
      ...Array(4).fill("web_search_input_invalid"),
      "web_search_rate_limited",
      "web_search_allowance_spent",
      "web_search_unauthorized",
      "web_search_provider_error",
      "web_search_output_invalid",
    ],
  );
  const labels = (recordedMetrics().get("providers.calls") ?? []).filter(
    (l) => l.port === "web_search",
  );
  assert.ok(labels.length > 0, "the calls were counted");
  const seen = inspect([errors, logs.raw, printed, labels], { depth: Infinity, showHidden: true });
  assert.deepEqual(
    ["quillmarsh"].filter((value) => seen.toLowerCase().includes(value)),
    [],
  );
  assert.equal(logs.lines().length, errors.length, "the refusals were logged");
  const folder = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.split("/").includes("tests"))
    .map((file) => `${folder}${file}`);
  assert.ok(
    files.some((file) => file.endsWith("web-search/brave/client.ts")),
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

test("a live world gets exactly one search, of the query it names, every other case skipped; never under APP_ENV=production", async () => {
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
  assert.match(live.output, /live searches: 1\n/);
  assert.match(live.output, /✔ answers the results of the search the world names/);
  assert.match(live.output, /ℹ pass 2\n/, "the methods, and the one search");
  assert.match(live.output, /ℹ skipped 10\n/);
  assert.equal(live.output.match(/# offline only: a live run makes one search/g)?.length, 10);
  assert.notEqual(production.code, 0, production.output);
  assert.match(production.output, /the web-search live suite is refused under APP_ENV=production/);
  assert.doesNotMatch(production.output, /live searches/);
});

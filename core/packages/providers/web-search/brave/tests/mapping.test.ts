// The Brave adapter's mapping and error tests (README.md "Tests"), offline: braveWebSearch() against a
// node:http server of the test's own on 127.0.0.1, serving the synthetic answers of fixtures/ (shaped
// like Brave's documentation, never recorded) and recording each request, so that the adapter's real
// request code runs. No vendor is called; the key is made up for the run. The port's contract suite
// runs here too, on the same server. The config and the live suite's gate run in child processes,
// since the config is read when the adapter is imported; none of them has a key, so none can call out.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { inspect } from "node:util";
import { collectLogs, createLogger, isAppError, recordedMetrics } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import {
  type OfflineWorld,
  PROVIDER_ERROR_STATUS,
  RETRY_AFTER_SEC,
  webSearchCases,
} from "../../contract.ts";
import { QUERY, RESULTS, SITE } from "../../fake/tests/world.ts";
import { type WebResult, webSearchPort } from "../../port.ts";
import { RETRY_AFTER_SEC as DEFAULT_WAIT, MAX_ANSWER_BYTES } from "../constants.ts";
import { braveWebSearch } from "../index.ts";

/** Made up for the run, so that no string in the repository looks like a key. */
const KEY = randomBytes(24).toString("base64url");
const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const ERRORS = JSON.parse(fixture("errors.json")) as Record<string, unknown>;
const errorBody = (name: string) => JSON.stringify(ERRORS[name]);
/** The query the fixture web-search.json answers. */
const FIXTURE_QUERY = "Copper Harbor Labs official website fixture";

/** An answer: a status, headers, a body; `chunked`, sent in pieces with no length; `silent`, never sent. */
type Answer = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  chunked?: true;
  silent?: true;
};
/** Each request: the method, the path, the query's parameters in order, the headers, the body. */
const received: {
  method: string;
  url: string;
  path: string;
  params: [string, string][];
  headers: Record<string, string | string[] | undefined>;
  body: string;
}[] = [];
/** The next answers, whatever the requests; then the seeded `q`s, then FIXTURE_QUERY, else none. */
const answers: Answer[] = [];
/** Brave's answer per `q`, and per `q#<offset>` for a further page, built from results in the port's words (the contract's world). */
const seeded = new Map<string, readonly WebResult[]>();
const asBrave = (results: readonly WebResult[]) =>
  JSON.stringify({
    type: "search",
    web: {
      type: "search",
      results: results.map(({ url, title, snippet }) => ({
        title,
        url,
        description: snippet,
        is_source_local: false,
        language: "en",
      })),
    },
  });

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  received.push({
    method: request.method ?? "",
    url: request.url ?? "",
    path: url.pathname,
    params: [...url.searchParams],
    headers: request.headers,
    body,
  });
  const q = url.searchParams.get("q") ?? "";
  const offset = url.searchParams.get("offset");
  const results = seeded.get(offset === null ? q : `${q}#${offset}`);
  const routed: Answer = results
    ? { body: asBrave(results) }
    : { body: fixture(q === FIXTURE_QUERY ? "web-search.json" : "no-web.json") };
  const answer = answers.shift() ?? routed;
  if (answer.silent) return;
  const text = answer.body ?? "";
  response.writeHead(answer.status ?? 200, {
    "content-type": "application/json",
    ...answer.headers,
  });
  if (!answer.chunked) return void response.end(text);
  for (let at = 0; at < text.length; at += 65_536) response.write(text.slice(at, at + 65_536));
  response.end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  received.length = 0;
  answers.length = 0;
});
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const brave = bindPort(webSearchPort, braveWebSearch({ baseUrl, apiKey: KEY, now: () => NOW }), {
  adapter: "brave",
});

/** Brave's answers the contract's failures stand for. */
const FAILURES = {
  web_search_rate_limited: {
    status: 429,
    headers: { "retry-after": String(RETRY_AFTER_SEC) },
    body: errorBody("rate-limited"),
  },
  web_search_allowance_spent: { status: 429, body: errorBody("quota-limited") },
  web_search_unauthorized: { status: 422, body: errorBody("token-invalid") },
  web_search_provider_error: { status: PROVIDER_ERROR_STATUS, body: "Service Unavailable" },
} as const;
const world: OfflineWorld = {
  live: false,
  search: () => {
    seeded.set(QUERY, RESULTS);
    return { search: { query: QUERY, count: 5 }, results: RESULTS };
  },
  onSite: () => {
    // Brave is served every result for the site's query: the adapter keeps those on the site.
    seeded.set(`${QUERY} site:${SITE}`, RESULTS);
    const results = RESULTS.filter(({ url }) => new URL(url).hostname.endsWith(SITE));
    return { search: { query: QUERY, site: SITE, count: 5 }, results };
  },
  further: () => {
    seeded.set(QUERY, RESULTS.slice(0, 2));
    seeded.set(`${QUERY}#1`, RESULTS.slice(2));
    const search = { query: QUERY, count: 2, country: "GB", language: "en", page: 2 };
    return { search, results: RESULTS.slice(2), first: RESULTS.slice(0, 2) };
  },
  nothing: () => ({ query: "Nobody Seeded Holdings", count: 3 }),
  failNext: (code) => void answers.push({ ...FAILURES[code] }),
  calls: () => received.length,
};
contractSuite(
  webSearchPort,
  {
    port: webSearchPort,
    name: "brave",
    requires: [],
    create: () => braveWebSearch({ baseUrl, apiKey: KEY, now: () => NOW }),
  },
  webSearchCases(world),
);

const fails = (code: string, details?: Record<string, unknown>) => (error: unknown) => {
  assert.ok(isAppError(error) && error.code === code, `${code}, not ${String(error)}`);
  if (details) assert.deepEqual(error.details, details);
  return true;
};
/** The headers Node's fetch sends of its own, on every request. */
const TRANSPORT = new Set([
  "host",
  "connection",
  "user-agent",
  "accept-language",
  "accept-encoding",
  "sec-fetch-mode",
]);

test("the request carries the query, the count and the key header, and nothing else; a site goes into the query as site:", async () => {
  await brave.searchWeb({ query: FIXTURE_QUERY, count: 3 });
  await brave.searchWeb({ query: FIXTURE_QUERY, site: "linkedin.com", count: 2 });
  assert.deepEqual(
    received.map(({ method, path, params, body }) => [method, path, params, body]),
    [
      [
        "GET",
        "/res/v1/web/search",
        [
          ["q", FIXTURE_QUERY],
          ["count", "3"],
        ],
        "",
      ],
      [
        "GET",
        "/res/v1/web/search",
        [
          ["q", `${FIXTURE_QUERY} site:linkedin.com`],
          ["count", "2"],
        ],
        "",
      ],
    ],
  );
  for (const request of received) {
    const own = Object.keys(request.headers).filter((name) => !TRANSPORT.has(name));
    assert.deepEqual(own.toSorted(), ["accept", "x-subscription-token"]);
    assert.equal(request.headers["x-subscription-token"], KEY, "the key in its header");
    assert.equal(request.headers.accept, "application/json");
    assert.ok(!request.url.includes(KEY), "the key never in the URL");
  }
});

test("a country, a language and a page go in Brave's own parameters, country, search_lang and offset (the page minus one), and nothing else new; ones Brave has no filter for are searched without it", async () => {
  const params = async (more: Partial<Parameters<typeof brave.searchWeb>[0]>) => {
    received.length = 0;
    await brave.searchWeb({ query: FIXTURE_QUERY, count: 3, ...more });
    return received.map((request) => request.params.filter(([name]) => name !== "q"));
  };
  assert.deepEqual(await params({ country: "DE", language: "de", page: 3 }), [
    [
      ["count", "3"],
      ["country", "DE"],
      ["search_lang", "de"],
      ["offset", "2"],
    ],
  ]);
  assert.deepEqual(await params({ page: 1 }), [[["count", "3"]]], "page 1 is today's request");
  assert.deepEqual(await params({ country: "US" }), [
    [
      ["count", "3"],
      ["country", "US"],
    ],
  ]);
  assert.deepEqual(await params({ language: "zh" }), [
    [
      ["count", "3"],
      ["search_lang", "zh-hans"],
    ],
  ]);
  assert.deepEqual(await params({ language: "pt" }), [
    [
      ["count", "3"],
      ["search_lang", "pt-pt"],
    ],
  ]);
  // A country or a language of the right form that Brave does not list: no filter, no refusal.
  assert.deepEqual(await params({ country: "ZZ", language: "zz" }), [[["count", "3"]]]);
  assert.deepEqual(await params({ country: "IS", language: "xx", page: 5 }), [
    [
      ["count", "3"],
      ["offset", "4"],
    ],
  ]);
});

test("Brave's web results map to the port's: https links only, plain text cut to 300 characters, the first `count`; on a site, the site's only; no web results, none", async () => {
  const raw = JSON.parse(fixture("web-search.json")) as {
    web: { results: { description?: string }[] };
  };
  const long = raw.web.results[2]?.description ?? "";
  assert.ok(long.length > 300);
  const mapped = [
    {
      url: "https://copper-harbor.example/",
      title: "Copper Harbor Labs 'Official' Site",
      snippet: "Copper Harbor Labs builds synthetic tools & fixtures &lt;for tests&gt;.",
    },
    {
      url: "https://www.linkedin.com/company/copper-harbor-labs",
      title: "Copper Harbor Labs | LinkedIn",
      snippet: long.slice(0, 300),
    },
    { url: "https://news.copper-harbor.example/about", title: "About us", snippet: "" },
  ];
  assert.deepEqual(await brave.searchWeb({ query: FIXTURE_QUERY, count: 10 }), {
    results: mapped,
  });
  assert.deepEqual(await brave.searchWeb({ query: FIXTURE_QUERY, count: 2 }), {
    results: mapped.slice(0, 2),
  });
  answers.push({ body: fixture("web-search.json") });
  assert.deepEqual(
    await brave.searchWeb({ query: FIXTURE_QUERY, site: "linkedin.com", count: 5 }),
    {
      results: [mapped[1]],
    },
  );
  assert.deepEqual(await brave.searchWeb({ query: "Nobody Seeded Holdings", count: 5 }), {
    results: [],
  });
  answers.push({ body: JSON.stringify({ type: "search", web: null }) });
  assert.deepEqual(await brave.searchWeb({ query: QUERY, count: 5 }), { results: [] });
});

test("Brave's errors map as the README's table says, with the status and Brave's code, never the body", async () => {
  const search = { query: QUERY, count: 3 };
  const date = new Date(NOW + 120_000).toUTCString();
  const rows: readonly (readonly [Answer, string, Record<string, unknown>])[] = [
    [
      { status: 429, headers: { "retry-after": "7" } },
      "web_search_rate_limited",
      { retryAfterSec: 7 },
    ],
    [
      { status: 429, headers: { "retry-after": date } },
      "web_search_rate_limited",
      { retryAfterSec: 120 },
    ],
    [
      {
        status: 429,
        headers: { "x-ratelimit-reset": "1, 1419704" },
        body: errorBody("rate-limited"),
      },
      "web_search_rate_limited",
      { retryAfterSec: 1 },
    ],
    [{ status: 429 }, "web_search_rate_limited", { retryAfterSec: DEFAULT_WAIT }],
    [
      { status: 429, headers: { "retry-after": "7" }, body: errorBody("quota-limited") },
      "web_search_allowance_spent",
      { status: 429, code: "QUOTA_LIMITED" },
    ],
    [{ status: 402 }, "web_search_allowance_spent", { status: 402 }],
    [{ status: 401 }, "web_search_unauthorized", { status: 401 }],
    [{ status: 403 }, "web_search_unauthorized", { status: 403 }],
    [
      { status: 422, body: errorBody("token-invalid") },
      "web_search_unauthorized",
      { status: 422, code: "SUBSCRIPTION_TOKEN_INVALID" },
    ],
    [
      { status: 422, body: errorBody("validation") },
      "web_search_provider_error",
      { status: 422, code: "VALIDATION" },
    ],
    [{ status: 500, body: "<html>oops</html>" }, "web_search_provider_error", { status: 500 }],
    [
      { status: 302, headers: { location: `${baseUrl}/elsewhere` } },
      "web_search_provider_error",
      { status: 302, reason: "redirect" },
    ],
    [
      { body: "<html>not json</html>" },
      "web_search_provider_error",
      { status: 200, reason: "not JSON" },
    ],
    [
      { body: '"a string"' },
      "web_search_provider_error",
      { status: 200, reason: "an answer off the documented shape" },
    ],
    [
      { body: "x".repeat(MAX_ANSWER_BYTES + 1) },
      "web_search_provider_error",
      { status: 200, reason: "answer_too_large" },
    ],
    [
      { body: "x".repeat(MAX_ANSWER_BYTES + 1), chunked: true },
      "web_search_provider_error",
      { status: 200, reason: "answer_too_large" },
    ],
  ];
  for (const [answer, code, details] of rows) {
    answers.push(answer);
    await assert.rejects(brave.searchWeb(search), fails(code, details), JSON.stringify(details));
  }
  assert.equal(received.length, rows.length, "one request each: no retry, no redirect followed");
  assert.ok(received.every(({ path }) => path === "/res/v1/web/search"));
});

test("no answer: past the timeout, provider_error with reason timeout; a closed port, unreachable with its code", async () => {
  const slow = braveWebSearch({ baseUrl, apiKey: KEY, timeoutMs: 100 });
  const slowPort = bindPort(webSearchPort, slow, { adapter: "brave" });
  answers.push({ silent: true });
  await assert.rejects(
    slowPort.searchWeb({ query: QUERY, count: 3 }),
    fails("web_search_provider_error", { reason: "timeout" }),
  );
  const closed = createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const { port } = closed.address() as AddressInfo;
  closed.close();
  await once(closed, "close");
  const gone = braveWebSearch({ baseUrl: `http://127.0.0.1:${port}`, apiKey: KEY });
  await assert.rejects(
    bindPort(webSearchPort, gone, { adapter: "brave" }).searchWeb({ query: QUERY, count: 3 }),
    fails("web_search_provider_error", { reason: "unreachable", code: "ECONNREFUSED" }),
  );
});

test("the key and the query reach no error, log line, console line or metric label", async (t) => {
  const logs = collectLogs();
  const logger = createLogger({ destination: logs.destination });
  const printed: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    t.mock.method(console, level, (...args: unknown[]) => void printed.push(args));
  const query = "Quillmarsh Tide Holdings official website";
  const site = "quillmarsh-tide.example";
  const failures: Answer[] = [
    ...Object.values(FAILURES),
    { status: 302, headers: { location: `${baseUrl}/?q=quillmarsh` } },
    { body: "x".repeat(MAX_ANSWER_BYTES + 1) },
    { body: "quillmarsh" },
    { status: 400, body: JSON.stringify({ error: { code: "quillmarsh", detail: query } }) },
  ];
  const errors: unknown[] = [];
  await brave.searchWeb({ query, site, count: 3 });
  for (const answer of failures) {
    answers.push(answer);
    const error = await brave.searchWeb({ query, site, count: 3 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.ok(isAppError(error), String(error));
    errors.push(error);
    logger.error({ err: error }, "web search failed"); // as a host logs a failure
  }
  assert.equal(errors.length, failures.length);
  const labels = (recordedMetrics().get("providers.calls") ?? []).filter(
    (l) => l.port === "web_search",
  );
  assert.ok(labels.length > 0, "the calls were counted");
  const seen = inspect([errors, logs.raw, printed, labels], { depth: Infinity, showHidden: true });
  assert.ok(!seen.includes(KEY), "no key");
  assert.ok(!seen.toLowerCase().includes("quillmarsh"), "no query, no site, no body");
  assert.equal(logs.lines().length, errors.length);
});

/** A child process: `node --test <file>` or a module script, with `env` over a keyless environment. */
async function child(args: string[], env: Record<string, string>) {
  const { NODE_TEST_CONTEXT: _context, ...parent } = process.env;
  const keyless = { ...parent, BRAVE_API_KEY: "", BRAVE_ALLOWANCE: "", BRAVE_TEST_QUERY: "" };
  const run = spawn(process.execPath, args, {
    env: { ...keyless, APP_ENV: "test", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  run.stdout.on("data", (chunk) => {
    output += chunk;
  });
  run.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve) => run.on("close", resolve));
  return { code, output };
}

test("the live suite runs only with BRAVE_TEST_QUERY set, never under APP_ENV=production; without a key it is skipped (no child has one)", async () => {
  const file = join(import.meta.dirname, "contract.test.ts");
  const reporter = ["--test-reporter=spec", "--test-reporter-destination=stdout"];
  const runAs = (env: Record<string, string>) => child(["--test", ...reporter, file], env);
  const [noQuery, noKey, production] = await Promise.all([
    runAs({}),
    runAs({ BRAVE_TEST_QUERY: QUERY }),
    runAs({ BRAVE_TEST_QUERY: QUERY, APP_ENV: "production" }),
  ]);
  assert.equal(noQuery.code, 0, noQuery.output);
  assert.match(noQuery.output, /skipped: no BRAVE_TEST_QUERY/);
  assert.match(noQuery.output, /ℹ pass 0\n[\s\S]*ℹ skipped 1\n/);
  assert.equal(noKey.code, 0, noKey.output);
  assert.match(noKey.output, /skipped: no credentials \(BRAVE_API_KEY\)/);
  assert.match(noKey.output, /ℹ pass 0\n[\s\S]*ℹ skipped 1\n/);
  assert.notEqual(production.code, 0, production.output);
  assert.match(production.output, /the web-search live suite is refused under APP_ENV=production/);
});

test("BRAVE_ALLOWANCE is the bound adapter's allowance, empty none, off its form a start failure; create() refuses an empty key", async () => {
  const index = JSON.stringify(import.meta.resolve("../index.ts"));
  const script = [
    "try {",
    `  const { braveAdapter } = await import(${index});`,
    "  let created;",
    "  try { created = Object.keys(braveAdapter.create()).join(); }",
    "  catch (error) { created = `${error.code} ${error.details.variables}`; }",
    "  console.log(JSON.stringify({ allowance: braveAdapter.allowance, openData: braveAdapter.openData, created }));",
    "} catch (error) { console.log(error.code); }",
  ].join("\n");
  const runWith = async (env: Record<string, string>) =>
    (await child(["--input-type=module", "-e", script], env)).output.trim();
  const key = randomBytes(24).toString("base64url");
  const outcomes = await Promise.all([
    runWith({ BRAVE_ALLOWANCE: "1000/month" }),
    runWith({ BRAVE_API_KEY: key }),
    runWith({ BRAVE_ALLOWANCE: "lots" }),
  ]);
  assert.deepEqual(outcomes, [
    JSON.stringify({
      allowance: { calls: 1000, per: "month" },
      openData: false,
      created: "config_invalid BRAVE_API_KEY: required by the brave adapter",
    }),
    JSON.stringify({ allowance: null, openData: false, created: "searchWeb" }),
    "config_invalid",
  ]);
});

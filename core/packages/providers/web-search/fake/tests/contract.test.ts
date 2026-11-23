// The fake's contract suite (../../README.md "The contract suite"), in the world of world.ts, then the
// fake's own: seedResults by query, in any case; the site and the count; setAllowance through the
// registry; failNext's details; create() under APP_ENV=production.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { getAdapter, getAdapters } from "../../../registry.ts";
import { contractSuite } from "../../../testing/index.ts";
import { webSearchCases } from "../../contract.ts";
import { type WebSearch, webSearchPort } from "../../port.ts";
import { PROVIDER_ERROR_STATUS, RETRY_AFTER_SEC } from "../constants.ts";
import { webSearchFake, webSearchFakeAdapter } from "../index.ts";
import { fakeWorld, QUERY, RESULTS } from "./world.ts";

contractSuite(webSearchPort, webSearchFakeAdapter, webSearchCases(fakeWorld(webSearchFake)));

/** The fake bound as the registry binds it, reset. */
function boundFake() {
  const webSearch = bindPort(webSearchPort, webSearchFakeAdapter.create(), { adapter: "fake" });
  webSearchFake.reset();
  return webSearch;
}

test("seedResults keys results by their query, in any case; a site keeps its host and its subdomains only; count keeps the first; a search answers a copy", async () => {
  const webSearch = boundFake();
  const other = { url: "https://notlinkedin.com/copper", title: "Elsewhere", snippet: "" };
  webSearchFake.seedResults(QUERY, [...RESULTS, other]);
  const urls = async (search: { query: string; site?: string; count: number }) =>
    (await webSearch.searchWeb(search)).results.map(({ url }) => url);
  assert.deepEqual(await urls({ query: QUERY.toUpperCase(), count: 10 }), [
    ...RESULTS.map(({ url }) => url),
    other.url,
  ]);
  assert.deepEqual(
    await urls({ query: QUERY, count: 2 }),
    RESULTS.slice(0, 2).map((r) => r.url),
  );
  assert.deepEqual(await urls({ query: QUERY, site: "linkedin.com", count: 10 }), [
    "https://www.linkedin.com/company/copper-harbor-labs",
  ]);
  assert.deepEqual(await urls({ query: QUERY, site: "copper-harbor.example", count: 10 }), [
    "https://copper-harbor.example/",
    "https://news.copper-harbor.example/about",
  ]);
  assert.deepEqual(await urls({ query: "Nobody Seeded", count: 10 }), []);
  assert.equal(webSearchFake.recordedCalls.length, 5);
  const answer = await webSearch.searchWeb({ query: QUERY, count: 1 });
  Object.assign(answer.results[0] ?? {}, { title: "Changed" });
  assert.deepEqual(await webSearch.searchWeb({ query: QUERY, count: 1 }), {
    results: RESULTS.slice(0, 1),
  });
  webSearchFake.reset();
  assert.deepEqual(await urls({ query: QUERY, count: 10 }), []);
});

test("a search with a country, a language and page 2 answers the second page of `count` and records the three; no page is page 1, a page past the results none", async () => {
  const webSearch = boundFake();
  const more = Array.from({ length: 5 }, (_, at) => ({
    url: `https://harbor-${at}.example/`,
    title: `Harbor ${at}`,
    snippet: "",
  }));
  webSearchFake.seedResults(QUERY, more);
  const urls = async (search: Parameters<typeof webSearch.searchWeb>[0]) =>
    (await webSearch.searchWeb(search)).results.map(({ url }) => url);
  const at = (...indexes: number[]) => indexes.map((index) => more[index]?.url);
  assert.deepEqual(await urls({ query: QUERY, count: 2 }), at(0, 1));
  assert.deepEqual(await urls({ query: QUERY, count: 2, page: 1 }), at(0, 1));
  assert.deepEqual(
    await urls({ query: QUERY, count: 2, country: "GB", language: "en", page: 2 }),
    at(2, 3),
  );
  assert.deepEqual(await urls({ query: QUERY, count: 2, page: 3 }), at(4));
  assert.deepEqual(await urls({ query: QUERY, count: 2, page: 4 }), []);
  assert.deepEqual(
    webSearchFake.recordedCalls.map(({ input }) => {
      const { country, language, page } = input as WebSearch;
      return [country, language, page];
    }),
    [
      [undefined, undefined, undefined],
      [undefined, undefined, 1],
      ["GB", "en", 2],
      [undefined, undefined, 3],
      [undefined, undefined, 4],
    ],
  );
});

test("setAllowance sets the allowance the registry's fake exposes, read on every access; reset clears it; the fake's data is not open data", async () => {
  const [fake] = await getAdapters(webSearchPort, ["fake"]);
  assert.ok(fake);
  assert.equal(fake, await getAdapter(webSearchPort, "fake"));
  webSearchFake.reset();
  assert.deepEqual([fake.allowance, fake.openData], [null, false]);
  webSearchFake.setAllowance({ calls: 1000, per: "month" });
  assert.deepEqual(fake.allowance, { calls: 1000, per: "month" });
  assert.deepEqual(webSearchFakeAdapter.allowance, { calls: 1000, per: "month" });
  webSearchFake.reset();
  assert.equal(fake.allowance, null);
  assert.equal(Object.keys(fake).includes("allowance"), false, "not among the methods");
});

test("failNext's rate limit carries retryAfterSec and its provider error a status, unless the details give them", async () => {
  const webSearch = boundFake();
  type Code = Parameters<typeof webSearchFake.failNext>[0];
  const failure = async (code: Code, details?: Record<string, unknown>) => {
    webSearchFake.failNext(code, details);
    const error = await webSearch.searchWeb({ query: QUERY, count: 3 }).then(
      () => assert.fail("the call failed"),
      (caught: unknown) => caught,
    );
    assert.ok(isAppError(error) && error.code === code);
    return error.details;
  };
  assert.deepEqual(await failure("web_search_rate_limited"), { retryAfterSec: RETRY_AFTER_SEC });
  assert.deepEqual(await failure("web_search_rate_limited", { retryAfterSec: 5 }), {
    retryAfterSec: 5,
  });
  assert.deepEqual(await failure("web_search_provider_error"), { status: PROVIDER_ERROR_STATUS });
  assert.equal(await failure("web_search_allowance_spent"), undefined);
  assert.equal(await failure("web_search_unauthorized"), undefined);
});

test("create() refuses APP_ENV=production with adapter_invalid, through the registry too", async () => {
  const fake = JSON.stringify(import.meta.resolve("../index.ts"));
  const registry = JSON.stringify(import.meta.resolve("../../../registry.ts"));
  const port = JSON.stringify(import.meta.resolve("../../port.ts"));
  const script = [
    `const { webSearchFakeAdapter } = await import(${fake});`,
    `const { getAdapters } = await import(${registry});`,
    `const { webSearchPort } = await import(${port});`,
    "const outcome = (run) => run().then(() => 'created', (error) => error.code);",
    "const direct = await outcome(async () => webSearchFakeAdapter.create());",
    "const listed = await outcome(() => getAdapters(webSearchPort, ['fake']));",
    "console.log(`${direct} ${listed}`);",
  ].join("\n");
  const runAs = (APP_ENV: string) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APP_ENV },
    }).then(({ stdout }) => `${APP_ENV} ${stdout.trim()}`);
  assert.deepEqual(await Promise.all(["test", "production"].map(runAs)), [
    "test created created",
    "production adapter_invalid adapter_invalid",
  ]);
});

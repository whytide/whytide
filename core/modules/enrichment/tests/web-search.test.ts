// The counted search (gamma-wr-010; README "Public interface", "Allowances"; domain/web-search.ts), on
// the web-search fake and a second fake adapter, its counters on this file's schema: the first
// adapter with room answers, with the adapter named; a spent one is passed, by its allowance or by
// the vendor's word; with every adapter spent the answer says so; a failure is passed on and, with
// none left, its code is the answer's; no adapter loaded is its own answer; the request reaches the
// adapter as it is, with the country, the language and the page; and two callers at once never pass
// an allowance of one together.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  createFake,
  defineAdapter,
  getAdapter,
  PAGE_MAX,
  type WebResult,
  type WebSearch,
  type WebSearchFake,
  webSearchPort,
} from "@whytide/providers";
import { searchWeb } from "../domain/web-search.ts";
import { useClock, useEnrichmentClient, useWebSearchAdapters } from "../testing/index.ts";

withTestDb();
useEnrichmentClient(asRole("app"));
useClock(() => new Date("2026-11-19T10:00:00Z"));
const fake = (await getAdapter(webSearchPort, "fake")) as unknown as WebSearchFake;

/** A second adapter: its answer given per test, its calls recorded. */
const second = createFake(webSearchPort, {
  state: () => ({ results: [] as WebResult[] }),
  methods: (self) => ({
    searchWeb: async () => ({ results: structuredClone(self.state.results) }),
  }),
});
defineAdapter(webSearchPort, { name: "second", create: () => second });

const QUERY = "Harbor Works";
const FIRST: WebResult = {
  url: "https://harbor-works.example/",
  title: "Harbor Works",
  snippet: "",
};
const OTHER: WebResult = { url: "https://other-works.example/", title: "Other Works", snippet: "" };
const usage = () =>
  asRole("owner").sourceUsage.findMany({
    select: { source: true, used: true, spent: true },
    orderBy: { source: "asc" },
  });

beforeEach(() => {
  fake.reset();
  second.reset();
  second.state.results = [OTHER];
  fake.seedResults(QUERY, [FIRST]);
  useWebSearchAdapters(["fake", "second"]);
});

test("the first adapter with room answers, named, and counted under web-search/<adapter>; the request reaches it as it is, with the country, the language and the page", async () => {
  const request = { query: QUERY, count: 4, country: "GB", language: "en", page: 2 };
  assert.deepEqual(await searchWeb(request), {
    status: "answered",
    results: [],
    adapter: "fake",
  });
  assert.deepEqual(
    fake.recordedCalls.map(({ input }) => input),
    [request],
  );
  assert.equal(second.recordedCalls.length, 0);
  assert.deepEqual(await searchWeb({ query: QUERY, count: 4 }), {
    status: "answered",
    results: [FIRST],
    adapter: "fake",
  });
  assert.deepEqual(await usage(), [{ source: "web-search/fake", used: 2, spent: false }]);
});

test("an adapter whose allowance is spent is passed with no call; with every adapter spent the answer is spent", async () => {
  fake.setAllowance({ calls: 1, per: "month" });
  second.state.results = [OTHER];
  assert.equal((await searchWeb({ query: QUERY, count: 3 })).status, "answered");
  assert.deepEqual(await searchWeb({ query: QUERY, count: 3 }), {
    status: "answered",
    results: [OTHER],
    adapter: "second",
  });
  assert.equal(fake.recordedCalls.length, 1);
  useWebSearchAdapters(["fake"]);
  assert.deepEqual(await searchWeb({ query: QUERY, count: 3 }), { status: "spent" });
  assert.equal(fake.recordedCalls.length, 1, "no call past the allowance");
});

test("the vendor's spent word marks the counter spent: the next adapter answers, and the one after it none while the period lasts", async () => {
  fake.failNext("web_search_allowance_spent");
  assert.equal((await searchWeb({ query: QUERY, count: 3 })).status, "answered");
  const calls = fake.recordedCalls.length;
  assert.equal((await searchWeb({ query: QUERY, count: 3 })).status, "answered");
  assert.equal(fake.recordedCalls.length, calls);
  assert.deepEqual(await usage(), [
    { source: "web-search/fake", used: 1, spent: true },
    { source: "web-search/second", used: 2, spent: false },
  ]);
  useWebSearchAdapters(["fake"]);
  assert.deepEqual(await searchWeb({ query: QUERY, count: 3 }), { status: "spent" });
});

test("a failing adapter passes the search on; with none left the answer is failed, with the last failure's code and error", async () => {
  fake.failNext("web_search_unauthorized");
  assert.deepEqual(await searchWeb({ query: QUERY, count: 3 }), {
    status: "answered",
    results: [OTHER],
    adapter: "second",
  });
  fake.failNext("web_search_provider_error");
  second.failNext("web_search_rate_limited");
  const failed = await searchWeb({ query: QUERY, count: 3 });
  assert.equal(failed.status, "failed");
  assert.equal(failed.status === "failed" && failed.code, "web_search_rate_limited");
  // A failure before a spent adapter is the answer, not "spent".
  fake.failNext("web_search_provider_error");
  second.failNext("web_search_allowance_spent");
  const last = await searchWeb({ query: QUERY, count: 3 });
  assert.equal(last.status === "failed" && last.code, "web_search_provider_error");
});

test("no adapter loaded is its own answer, with no call", async () => {
  useWebSearchAdapters([]);
  assert.deepEqual(await searchWeb({ query: QUERY, count: 3 }), { status: "no_adapter" });
  assert.equal(fake.recordedCalls.length, 0);
  assert.deepEqual(await usage(), []);
});

test("two callers at once never pass an allowance of one together: one is answered, the other spent", async () => {
  useWebSearchAdapters(["fake"]);
  fake.setAllowance({ calls: 1, per: "day" });
  const answers = await Promise.all([
    searchWeb({ query: QUERY, count: 3 }),
    searchWeb({ query: QUERY, count: 3 }),
  ]);
  assert.deepEqual(answers.map(({ status }) => status).toSorted(), ["answered", "spent"]);
  assert.equal(fake.recordedCalls.length, 1);
  assert.deepEqual(await usage(), [{ source: "web-search/fake", used: 1, spent: false }]);
});

test("a request off the port's form is failed, web_search_input_invalid, before any reservation or call: source_usage untouched, no fake call", async () => {
  const off = [
    { query: "", count: 3 },
    { query: QUERY, count: 3, country: "gb" },
    { query: QUERY, count: 3, page: PAGE_MAX + 1 },
    { query: QUERY, count: 3, offset: 10 },
  ];
  for (const request of off) {
    const answer = await searchWeb(request as WebSearch);
    assert.equal(answer.status, "failed");
    assert.equal(answer.status === "failed" && answer.code, "web_search_input_invalid");
  }
  assert.equal(fake.recordedCalls.length, 0);
  assert.equal(second.recordedCalls.length, 0);
  assert.deepEqual(await usage(), []);
});

// The research run's search (README.md "Web research"; gamma-wr-041) on the worktree's database, the
// web-search fake behind enrichment's counted search and the files fake: two made-up businesses in two
// countries and two languages each have their plan's queries asked one a step, in the plan's order,
// the request reaching the search with its country and language, 10 results and page 1; each answer is
// kept under raw/signals/<runId>/search/ and its query gets its asked_at and result count, the run's
// counts say how many; a step run again, or after its file was written, searches nothing; a query that
// holds an email address, a link or a phone number is refused before it is searched, counted by the
// gate; a search that fails is counted and skipped; SIGNALS_RESEARCH_SEARCHES_PER_RUN (2 here) ends the
// run's searches with counts.budget_reached, once; every adapter spent and no adapter loaded are told
// by their statuses; the last plan of a source is its newest, null before any, and another workspace's
// source is signal_source_not_found.
import assert from "node:assert/strict";
import { json } from "node:stream/consumers";
import { beforeEach, test } from "node:test";

process.env.PROVIDER_FILES = "fake";
process.env.SIGNALS_RESEARCH_SEARCHES_PER_RUN = "2";

const { withTenant } = await import("@whytide/db");
const { useEnrichmentClient, useWebSearchAdapters } = await import("@whytide/enrichment/testing");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { servicePrincipal } = await import("@whytide/platform");
const { filesConfig, filesPort, getAdapter, webSearchPort } = await import("@whytide/providers");
const { holdsContact } = await import("../domain/research/checks.ts");
const { lastPlanOf } = await import("../domain/research/last.ts");
const { searchKey, searchResearchQuery } = await import("../domain/research/search.ts");
const { createResearchPlan, createSignalRun, createSignalSource, useSignalsClient } = await import(
  "../testing/index.ts"
);

type WebResult = import("@whytide/providers").WebResult;
type SearchFake = import("@whytide/providers").WebSearchFake;
type Files = {
  reset(): void;
  list(input: { workspaceId: string; prefix: string }): Promise<{ files: { key: string }[] }>;
  get(input: {
    workspaceId: string;
    key: string;
  }): Promise<{ body: import("node:stream").Readable }>;
};
withTestDb();
const app = asRole("app");
useSignalsClient(app);
useEnrichmentClient(app);
const search = (await getAdapter(webSearchPort, "fake")) as unknown as SearchFake;
const files = (await getAdapter(filesPort, filesConfig.PROVIDER_FILES)) as unknown as Files;
const principal = servicePrincipal("signals_test");
const tenantOf =
  (workspaceId: string) =>
  <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
beforeEach(() => {
  search.reset();
  files.reset();
  useWebSearchAdapters(["fake"]);
});

/** Two made-up businesses, each with its country, language and queries. */
const BUSINESSES = {
  kestrel: {
    country: "PL",
    language: "pl",
    queries: ["rejestratory temperatury dystrybutor", "wystawcy targi logistyka"],
  },
  aurelia: {
    country: "CL",
    language: "es",
    queries: ["asociacion energia solar socios", "licitacion paneles solares techo"],
  },
} as const;
const resultsOf = (query: string, count = 3): WebResult[] =>
  Array.from({ length: count }, (_, at) => ({
    url: `https://site-${at + 1}.example/${encodeURIComponent(query).slice(0, 12)}`,
    title: `Result ${at + 1}`,
    snippet: "",
  }));

/** A workspace with a research source, its run open and its plan of these queries (none asked). */
async function planned(tag: string, queries: readonly string[], country = "PL", language = "pl") {
  const workspaceId = `wsp_search${tag}`;
  const config = { focus: "makers of cold-chain loggers" };
  const source = await createSignalSource({
    ...{ workspaceId, label: tag, kind: "web_research", config },
    senderAccountId: null,
  });
  const run = await createSignalRun({ workspaceId, sourceId: source.id, status: "running" });
  await createResearchPlan({
    ...{ workspaceId, sourceId: source.id, runId: run.id },
    queries: queries.map((text) => ({ text })),
  });
  // The factory writes the queries for PL and pl; these businesses' own country and language.
  await app.signalResearchQuery.updateMany({
    where: { sourceId: source.id },
    data: { country, language },
  });
  const ref = { workspaceId, sourceId: source.id, runId: run.id };
  const step = (position: number) => searchResearchQuery(ref, position, tenantOf(workspaceId));
  const counts = async () =>
    ((await app.signalRun.findFirstOrThrow({ where: { id: run.id } })).counts ?? {}) as Record<
      string,
      number
    >;
  const rows = () =>
    app.signalResearchQuery.findMany({
      where: { sourceId: source.id },
      orderBy: { position: "asc" },
    });
  return { ref, step, counts, rows, workspaceId };
}
const filed = async (workspaceId: string, key: string) => {
  const { files: found } = await files.list({ workspaceId, prefix: key });
  return found.map((file) => file.key.replace(`w/${workspaceId}/`, ""));
};

test("two businesses in two countries and two languages: each query is searched in the plan's order with its country and language, 10 results and page 1; its answer is kept under raw/signals/<runId>/search/<position>.json and the query gets its asked_at and result count; the run's counts say how many", async () => {
  for (const [tag, { country, language, queries }] of Object.entries(BUSINESSES)) {
    search.reset();
    const run = await planned(tag, queries, country, language);
    queries.forEach((query, at) => search.seedResults(query, resultsOf(query, at + 2)));
    assert.deepEqual(await run.step(1), { status: "asked" });
    assert.deepEqual(await run.step(2), { status: "asked" });
    const calls = search.recordedCalls.map(({ method, input }) => ({
      method,
      ...(input as object),
    }));
    assert.deepEqual(
      calls,
      queries.map((query) => ({
        ...{ method: "searchWeb", query, count: 10, country, language, page: 1 },
      })),
    );
    const rows = await run.rows();
    assert.deepEqual(
      rows.map((row) => [row.askedAt !== null, row.resultCount]),
      [
        [true, 2],
        [true, 3],
      ],
    );
    assert.deepEqual(await run.counts(), { searches_asked: 2, search_results: 5 });
    const keys = await filed(run.workspaceId, `raw/signals/${run.ref.runId}/`);
    assert.deepEqual(keys, [searchKey(run.ref.runId, 1), searchKey(run.ref.runId, 2)]);
    const body = (await json(
      (
        await files.get({ workspaceId: run.workspaceId, key: keys[1] ?? "" })
      ).body,
    )) as {
      placeId: string;
      country: string;
      language: string;
      adapter: string;
      results: unknown[];
    };
    assert.deepEqual(
      [body.placeId, body.country, body.language, body.adapter, body.results.length],
      ["web_search", country, language, "fake", 3],
    );
  }
});

test("a step run again searches nothing: a query asked is skipped, and one whose file an attempt before wrote, with its row not yet marked, is marked from the file with no second search, its counts added once", async () => {
  const run = await planned("retry", ["first query", "second query"]);
  search.seedResults("first query", resultsOf("first query", 4));
  assert.deepEqual(await run.step(1), { status: "asked" });
  assert.deepEqual(await run.step(1), { status: "skipped" });
  assert.equal(search.recordedCalls.length, 1);
  // The attempt before wrote the second answer's file and stopped before the row.
  const { writeRunFile } = await import("../domain/runs.ts");
  await writeRunFile(run.workspaceId, searchKey(run.ref.runId, 2), {
    results: resultsOf("second query", 2),
  });
  assert.deepEqual(await run.step(2), { status: "asked" });
  assert.equal(search.recordedCalls.length, 1, "no second search");
  assert.deepEqual(await run.counts(), { searches_asked: 2, search_results: 6 });
  assert.deepEqual(await run.step(2), { status: "skipped" });
  assert.deepEqual(await run.step(3), { status: "skipped" }, "no such position");
  assert.deepEqual(await run.counts(), { searches_asked: 2, search_results: 6 });
});

test("a query that holds an email address, a link or a phone number is refused before it is searched, counted by the gate, left unasked, and the next is searched", async () => {
  const held = [
    "distributors ops@kestrel.example",
    "see https://aurelia.example/list",
    "call +56 2 2345 6789 buyers",
  ];
  const run = await planned("contact", [...held, "plain query"]);
  search.seedResults("plain query", resultsOf("plain query", 1));
  for (const position of [1, 2, 3])
    assert.deepEqual(await run.step(position), { status: "refused" });
  assert.deepEqual(await run.step(4), { status: "asked" });
  assert.deepEqual(
    search.recordedCalls.map(({ input }) => (input as { query: string }).query),
    ["plain query"],
  );
  assert.deepEqual(
    (await run.rows()).map((row) => row.askedAt !== null),
    [false, false, false, true],
  );
  assert.deepEqual(await run.counts(), {
    searches_refused_contact: 3,
    searches_asked: 1,
    search_results: 1,
  });
});

test("a search that fails is counted and skipped, left unasked with no file, and the run goes on; the failure's code never reaches the counts", async () => {
  const run = await planned("failed", ["broken query", "good query"]);
  search.seedResults("good query", resultsOf("good query", 2));
  search.failNext("web_search_provider_error");
  assert.deepEqual(await run.step(1), { status: "failed" });
  assert.deepEqual(await run.step(2), { status: "asked" });
  assert.deepEqual(
    (await run.rows()).map((row) => row.askedAt !== null),
    [false, true],
  );
  assert.deepEqual(await filed(run.workspaceId, `raw/signals/${run.ref.runId}/`), [
    searchKey(run.ref.runId, 2),
  ]);
  assert.deepEqual(await run.counts(), {
    searches_failed: 1,
    searches_asked: 1,
    search_results: 2,
  });
});

test("at SIGNALS_RESEARCH_SEARCHES_PER_RUN (2) the third query is not searched and the run counts budget_reached once; its failed searches count against the limit too", async () => {
  const run = await planned("budget", ["one", "two", "three", "four"]);
  for (const query of ["one", "two", "three", "four"])
    search.seedResults(query, resultsOf(query, 1));
  search.failNext("web_search_provider_error");
  assert.deepEqual(await run.step(1), { status: "failed" });
  assert.deepEqual(await run.step(2), { status: "asked" });
  assert.deepEqual(await run.step(3), { status: "budget" });
  assert.deepEqual(await run.step(4), { status: "budget" });
  assert.equal(search.recordedCalls.length, 2);
  assert.deepEqual(await run.counts(), {
    ...{ searches_failed: 1, searches_asked: 1, search_results: 1 },
    budget_reached: 1,
  });
  assert.deepEqual(
    (await run.rows()).map((row) => row.askedAt !== null),
    [false, true, false, false],
  );
});

test("with every adapter spent the step says spent and counts it, the query left unasked; with no adapter loaded it says unavailable and counts nothing", async () => {
  const run = await planned("spent", ["one", "two"]);
  search.seedResults("one", resultsOf("one", 1));
  search.setAllowance({ calls: 1, per: "day" });
  assert.deepEqual(await run.step(1), { status: "asked" });
  assert.deepEqual(await run.step(2), { status: "spent" });
  assert.deepEqual(await run.counts(), { searches_asked: 1, search_results: 1, adapters_spent: 1 });
  assert.equal((await run.rows())[1]?.askedAt, null);
  useWebSearchAdapters([]);
  const none = await planned("none", ["one"]);
  assert.deepEqual(await none.step(1), { status: "unavailable" });
  assert.deepEqual(await none.counts(), {});
  assert.equal((await none.rows())[0]?.askedAt, null);
});

test("the last plan of a source is its newest, with its words and source types and when it was made; null before any; another workspace's source is signal_source_not_found", async () => {
  const mine = await planned("last", ["only query"]);
  const { workspaceId, ref } = mine;
  const none = await createSignalSource({
    ...{ workspaceId, label: "no plan", kind: "web_research" },
    config: { focus: "makers of cups" },
    senderAccountId: null,
  });
  assert.equal(await tenantOf(workspaceId)(() => lastPlanOf(none.id)), null);
  const later = await createSignalRun({ workspaceId, sourceId: ref.sourceId, status: "done" });
  await createResearchPlan({
    ...{ workspaceId, sourceId: ref.sourceId, runId: later.id },
    words: [{ language: "pl", words: ["gamma", "delta"] }],
    placeIds: ["web_search", "dealer_lists"],
    queries: [{ text: "later query" }],
  });
  const last = await tenantOf(workspaceId)(() => lastPlanOf(ref.sourceId));
  assert.deepEqual(
    [last?.runId, last?.words, last?.placeIds, last?.madeAt instanceof Date],
    [
      later.id,
      [{ language: "pl", words: ["gamma", "delta"] }],
      ["web_search", "dealer_lists"],
      true,
    ],
  );
  await assert.rejects(
    tenantOf("wsp_searchother")(() => lastPlanOf(ref.sourceId)),
    { code: "signal_source_not_found" },
  );
});

test("the query gate: years and short numbers pass, a phone number, an email address and a link are refused", () => {
  const passes = [
    "2024 2025",
    "licitación 2025",
    "lot 12 2025",
    "tender 2025 lot 123",
    "contratos adjudicados 2019-2024",
    "dealers in 3 regions",
    "plain words only",
  ];
  const refused = [
    "+52 55 1234 5678",
    "(555) 123-4567",
    "5551234567",
    "call 555.123.4567 now",
    "ops@kestrel.example buyers",
    "www.aurelia.example list",
    "https://aurelia.example/list",
  ];
  for (const text of passes) assert.equal(holdsContact(text), false, text);
  for (const text of refused) assert.equal(holdsContact(text), true, text);
});

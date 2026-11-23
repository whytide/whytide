// The candidates of a research run (README.md "Web research"; gamma-wr-046) on the worktree's database,
// the web-search fake behind enrichment's counted search, the files fake and contacts' never-contact
// list: two made-up businesses in two countries and two languages have the companies their pages
// named made candidates, one per source and domain, each with the page, source type, line and quote;
// a company named without a link has one search by its name and its place, inside the run's searches'
// limit (2 here), and its site is taken only by enrichment's test (`pickWebsite`); a company with no
// site is counted and kept nowhere; the workspace's own company, a never-contact company, a customer
// and a competitor are dropped before any read, each counted by its code; a company the source holds
// already is left, one read or dropped within the re-check days counted `dropped_recent`, an older one
// decided again; the next run checks the candidates left against the lists again and `pendingCandidates`
// hands them first, oldest first; no step's counts or answer holds a name.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

process.env.PROVIDER_FILES = "fake";
process.env.SIGNALS_RESEARCH_SEARCHES_PER_RUN = "3";

const { withTenant } = await import("@whytide/db");
const { addSuppression, useHashSalt } = await import("@whytide/contacts/testing");
const { useEnrichmentClient, useWebSearchAdapters } = await import("@whytide/enrichment/testing");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { newId, servicePrincipal } = await import("@whytide/platform");
const { filesConfig, filesPort, getAdapter, webSearchPort } = await import("@whytide/providers");
const { carryCandidates, makeCandidates, pendingCandidates } = await import(
  "../domain/research/candidates.ts"
);
const { gateRead } = await import("../domain/research/read-checks.ts");
const { namedKey, readJsonFile } = await import("../domain/research/files.ts");
const { writeRunFile } = await import("../domain/runs.ts");
const { createResearchCandidate, createSignalRun, createSignalSource, useSignalsClient } =
  await import("../testing/index.ts");

type SearchFake = import("@whytide/providers").WebSearchFake;
type Files = { reset(): void };
withTestDb();
const app = asRole("app");
useSignalsClient(app);
useEnrichmentClient(app);
useHashSalt("test-salt-".repeat(4));
const search = (await getAdapter(webSearchPort, "fake")) as unknown as SearchFake;
const files = (await getAdapter(filesPort, filesConfig.PROVIDER_FILES)) as unknown as Files;
const principal = servicePrincipal("signals_test");
const USER = "usr_candidates_tester";
const tenantOf =
  (workspaceId: string) =>
  <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
beforeEach(() => {
  search.reset();
  files.reset();
  useWebSearchAdapters(["fake"]);
});

type Named = {
  name: string;
  domain: string | null;
  place?: string | null;
  line?: string | null;
  quote?: string | null;
};
const DAY_MS = 86_400_000;

/** A workspace with a research source and a run open; `named(index, companies)` files a page's companies. */
async function business(tag: string, placeId = "fair_exhibitors") {
  const workspaceId = `wsp_cand${tag}`;
  const source = await createSignalSource({
    ...{ workspaceId, label: tag, kind: "web_research", config: { focus: "sellers of chillers" } },
    senderAccountId: null,
  });
  const newRun = async () => {
    const run = await createSignalRun({ workspaceId, sourceId: source.id, status: "running" });
    const ref = { workspaceId, sourceId: source.id, runId: run.id };
    const counts = async () =>
      ((await app.signalRun.findFirstOrThrow({ where: { id: run.id } })).counts ?? {}) as Record<
        string,
        number
      >;
    const named = (index: number, companies: Named[], pageUrl = `https://pages.example/${index}`) =>
      writeRunFile(workspaceId, namedKey(run.id, index), {
        pageUrl,
        placeId,
        companies: companies.map((company) => ({
          place: null,
          line: null,
          quote: null,
          ...company,
        })),
      });
    const make = (index: number) => makeCandidates(ref, index, tenantOf(workspaceId));
    const carry = () => carryCandidates(ref, tenantOf(workspaceId));
    return { ref, counts, named, make, carry };
  };
  const rows = () =>
    app.signalResearchCandidate.findMany({
      where: { sourceId: source.id },
      orderBy: { createdAt: "asc" },
    });
  const pending = () => tenantOf(workspaceId)(() => pendingCandidates(source.id));
  const inRun = tenantOf(workspaceId);
  return { workspaceId, sourceId: source.id, newRun, rows, pending, inRun };
}

test("two businesses in two countries and two languages: the companies a page named are candidates, one per source and domain, with the page, source type, line and quote; a company with no link is searched by its name and its place, and its site is taken by enrichment's test; one with no site is counted and kept nowhere", async () => {
  const kestrel = await business("kestrel");
  const run = await kestrel.newRun();
  await run.named(1, [
    {
      ...{ name: "Chłodnia Nord Sp. z o.o.", domain: "chlodnia-nord.example", place: "Warszawa" },
      line: "Distributes frozen food.",
      quote: "dystrybucja żywności mrożonej",
    },
    { name: "Mróz Logistyka", domain: null, place: "Łódź" },
    { name: "Arktyka Serwis", domain: null },
  ]);
  search.seedResults('"Mróz Logistyka" Łódź', [
    { url: "https://mroz-logistyka.example/", title: "Mróz Logistyka: transport", snippet: "" },
    { url: "https://www.facebook.com/mroz", title: "Mróz Logistyka - Facebook", snippet: "" },
  ]);
  assert.deepEqual(await run.make(1), { status: "made", made: 2 });
  assert.deepEqual(
    search.recordedCalls.map(({ input }) => input),
    [
      { query: '"Mróz Logistyka" Łódź', count: 5 },
      { query: '"Arktyka Serwis"', count: 5 },
    ],
  );
  const rows = await kestrel.rows();
  assert.deepEqual(
    rows.map(({ name, domain, place, state, line, quote, pageUrl, placeId, runId }) => ({
      ...{ name, domain, place, state, line, quote, pageUrl, placeId, runId },
    })),
    [
      {
        ...{ name: "Chłodnia Nord Sp. z o.o.", domain: "chlodnia-nord.example" },
        ...{ place: "Warszawa", state: "pending", line: "Distributes frozen food." },
        ...{ quote: "dystrybucja żywności mrożonej", pageUrl: "https://pages.example/1" },
        placeId: "fair_exhibitors",
        runId: run.ref.runId,
      },
      {
        ...{ name: "Mróz Logistyka", domain: "mroz-logistyka.example", place: "Łódź" },
        ...{ state: "pending", line: null, quote: null, pageUrl: "https://pages.example/1" },
        placeId: "fair_exhibitors",
        runId: run.ref.runId,
      },
    ],
  );
  assert.deepEqual(await run.counts(), { candidates: 2, candidates_no_site: 1, searches_asked: 2 });
  // The searches are kept in the page's file: a step run again searches and adds nothing.
  assert.deepEqual(await run.make(1), { status: "made", made: 0 });
  assert.equal(search.recordedCalls.length, 2);
  assert.deepEqual(await run.counts(), { candidates: 2, candidates_no_site: 1, searches_asked: 2 });
  assert.deepEqual(await run.make(9), { status: "skipped" });

  const aurelia = await business("aurelia", "public_tenders");
  const other = await aurelia.newRun();
  await other.named(1, [{ name: "Quillón Energía SpA", domain: null, place: "Concepción" }]);
  search.seedResults('"Quillón Energía SpA" Concepción', [
    { url: "https://quillon-energia.example/nosotros", title: "Quillón Energía SpA", snippet: "" },
  ]);
  assert.deepEqual(await other.make(1), { status: "made", made: 1 });
  assert.deepEqual(
    (await aurelia.rows()).map(({ domain, placeId }) => [domain, placeId]),
    [["quillon-energia.example", "public_tenders"]],
  );
  // Workspace B's candidates are not workspace A's.
  assert.deepEqual(await kestrel.pending().then((list) => list.map(({ domain }) => domain)), [
    "chlodnia-nord.example",
    "mroz-logistyka.example",
  ]);
});

test("the searches by name are inside the run's searches' limit: at the limit no more is asked, the run's counts say budget_reached once, and the companies left are counted with no site; a query that holds a phone number is refused before it is searched; a failed search and every adapter spent leave the company with no site", async () => {
  const biz = await business("limit");
  const run = await biz.newRun();
  // The plan's searches took two of the three; one is left.
  await app.signalRun.update({
    where: { id: run.ref.runId },
    data: { counts: { searches_asked: 2 } },
  });
  await run.named(1, [
    { name: "Taller 5551234567", domain: null },
    { name: "Frigo Uno", domain: null },
    { name: "Frigo Dos", domain: null },
    { name: "Frigo Tres", domain: null },
  ]);
  search.seedResults('"Frigo Uno"', [
    { url: "https://frigo-uno.example/", title: "Frigo Uno", snippet: "" },
  ]);
  assert.deepEqual(await run.make(1), { status: "made", made: 1 });
  assert.deepEqual(
    search.recordedCalls.map(({ input }) => (input as { query: string }).query),
    ['"Frigo Uno"'],
  );
  assert.deepEqual(await run.counts(), {
    ...{ searches_asked: 3, searches_refused_contact: 1, budget_reached: 1 },
    ...{ candidates: 1, candidates_no_site: 3 },
  });

  const failing = await business("limitfailed");
  const second = await failing.newRun();
  await second.named(1, [
    { name: "Frigo Cuatro", domain: null },
    { name: "Frigo Cinco", domain: null },
  ]);
  search.failNext("web_search_provider_error");
  search.seedResults('"Frigo Cinco"', [
    { url: "https://frigo-cinco.example/", title: "Frigo Cinco", snippet: "" },
  ]);
  assert.deepEqual(await second.make(1), { status: "made", made: 1 });
  assert.deepEqual(await second.counts(), {
    ...{ searches_failed: 1, searches_asked: 1, candidates: 1, candidates_no_site: 1 },
  });
  useWebSearchAdapters([]);
  const none = await failing.newRun();
  await none.named(1, [{ name: "Frigo Seis", domain: null }]);
  assert.deepEqual(await none.make(1), { status: "made", made: 0 });
  assert.deepEqual(await none.counts(), { candidates_no_site: 1 });
});

test("the workspace's own company, a never-contact company, a customer and a competitor are dropped before any read of their sites, each counted by its code and kept dropped; a subdomain of an own or blocked domain is dropped too, a lookalike is not", async () => {
  const biz = await business("drops");
  await app.companyKnowledge.create({
    data: {
      ...{ id: newId("ck"), workspaceId: biz.workspaceId, sourceUrl: "https://www.ownco.example" },
      ...{ oneLiner: "Chillers", products: ["Chillers"], painPoints: [] },
    },
  });
  const entry = (value: string, relationship?: "customer" | "competitor") =>
    biz.inRun(() => addSuppression({ kind: "company", value, createdBy: USER, relationship }));
  await entry("blocked.example");
  await entry("client.example", "customer");
  await entry("rival.example", "competitor");
  const run = await biz.newRun();
  await run.named(1, [
    { name: "Own Co", domain: "ownco.example" },
    { name: "Own Co EU", domain: "eu.ownco.example" },
    { name: "Blocked Ltd", domain: "blocked.example" },
    { name: "Blocked EU", domain: "eu.blocked.example" },
    { name: "Client SA", domain: "client.example" },
    { name: "Rival SA", domain: "rival.example" },
    { name: "Not Blocked", domain: "notblocked.example" },
    { name: "Not Own", domain: "notownco.example" },
    { name: "Not Own Again", domain: "notownco.example" },
  ]);
  assert.deepEqual(await run.make(1), { status: "made", made: 2 });
  assert.deepEqual(
    (await biz.rows()).map(({ domain, state, dropCode }) => [domain, state, dropCode]),
    [
      ["ownco.example", "dropped", "own_company"],
      ["eu.ownco.example", "dropped", "own_company"],
      ["blocked.example", "dropped", "never_contact"],
      ["eu.blocked.example", "dropped", "never_contact"],
      ["client.example", "dropped", "customer"],
      ["rival.example", "dropped", "competitor"],
      ["notblocked.example", "pending", null],
      ["notownco.example", "pending", null],
    ],
  );
  assert.deepEqual(await run.counts(), {
    ...{ dropped_own_company: 2, dropped_never_contact: 2, dropped_customer: 1 },
    ...{ dropped_competitor: 1, candidates: 2 },
  });
  assert.equal(search.recordedCalls.length, 0, "no search for a company with a link");
});

test("a company the source holds already is not made again: a pending one is counted known, one read or dropped within the re-check days dropped_recent, one older than the days is decided again; a company another page of the same run named is left", async () => {
  const biz = await business("recheck");
  const ws = { workspaceId: biz.workspaceId, sourceId: biz.sourceId };
  const old = new Date(Date.now() - 400 * DAY_MS);
  const recent = new Date(Date.now() - 10 * DAY_MS);
  await createResearchCandidate({ ...ws, domain: "waiting.example" });
  await createResearchCandidate({ ...ws, domain: "done.example", state: "read", stateAt: recent });
  await createResearchCandidate({
    ...{ ...ws, domain: "refused.example", state: "dropped", dropCode: "never_contact" },
    stateAt: recent,
  });
  await createResearchCandidate({ ...ws, domain: "ancient.example", state: "read", stateAt: old });
  const run = await biz.newRun();
  await run.named(1, [
    { name: "Waiting", domain: "waiting.example" },
    { name: "Done", domain: "done.example" },
    { name: "Refused", domain: "refused.example" },
    { name: "Ancient", domain: "ancient.example", line: "Back in the news." },
    { name: "Fresh", domain: "fresh.example" },
  ]);
  await run.named(2, [{ name: "Fresh again", domain: "fresh.example" }]);
  assert.deepEqual(await run.make(1), { status: "made", made: 2 });
  assert.deepEqual(await run.make(2), { status: "made", made: 0 });
  assert.deepEqual(await run.counts(), { candidates_known: 1, dropped_recent: 2, candidates: 2 });
  const rows = new Map((await biz.rows()).map((row) => [row.domain, row]));
  assert.equal(rows.get("ancient.example")?.state, "pending");
  assert.equal(rows.get("ancient.example")?.line, "Back in the news.");
  assert.equal(rows.get("ancient.example")?.runId, run.ref.runId);
  assert.equal(rows.get("done.example")?.state, "read");
  assert.equal(rows.get("fresh.example")?.name, "Fresh");
});

test("the next run reads the candidates left first: it checks them against the lists again, drops one now never contacted and counts the rest carried, and pendingCandidates hands the earlier run's before the run's own", async () => {
  const biz = await business("carry");
  const first = await biz.newRun();
  await first.named(1, [
    { name: "Alfa", domain: "alfa.example", quote: "q" },
    { name: "Beta", domain: "beta.example" },
    { name: "Gamma", domain: "gamma.example" },
  ]);
  assert.deepEqual(await first.make(1), { status: "made", made: 3 });
  // Between the runs: Beta joins the never-contact list and Gamma was read.
  await biz.inRun(() =>
    addSuppression({ kind: "company", value: "beta.example", createdBy: USER }),
  );
  await app.signalResearchCandidate.updateMany({
    where: { domain: "gamma.example" },
    data: { state: "read" },
  });
  const second = await biz.newRun();
  assert.deepEqual(await second.carry(), { carried: 1 });
  assert.deepEqual(await second.counts(), { dropped_never_contact: 1, candidates_carried: 1 });
  await second.named(1, [{ name: "Delta", domain: "delta.example" }]);
  assert.deepEqual(await second.make(1), { status: "made", made: 1 });
  const pending = await biz.pending();
  assert.deepEqual(
    pending.map(({ domain }) => domain),
    ["alfa.example", "delta.example"],
  );
  assert.equal(pending[0]?.quote, "q");
  const beta = (await biz.rows()).find(({ domain }) => domain === "beta.example");
  assert.deepEqual([beta?.state, beta?.dropCode], ["dropped", "never_contact"]);
  // A source gone: no page file is read for it.
  assert.deepEqual(await makeCandidates({ ...second.ref, sourceId: "src_gone" }, 1, biz.inRun), {
    status: "gone",
  });
});

test("a list page whose companies link to their profiles on the page's own host (or a subdomain of it) gives no domain: the profile is the directory's, the two companies are searched by their names, and no candidate holds the page's domain", async () => {
  const kestrel = await business("profiles");
  const run = await kestrel.newRun();
  const page = {
    url: "https://fair.example/exhibitors",
    finalUrl: "https://fair.example/exhibitors",
    title: "Exhibitors",
    text: "Chłodnia Nord, Warszawa. Mróz Logistyka, Łódź.",
    links: ["https://fair.example/exhibitors/1", "https://stands.fair.example/mroz"],
  };
  const gated = gateRead(
    {
      is: "company_list",
      companies: [
        { name: "Chłodnia Nord", link: "https://fair.example/exhibitors/1", place: "Warszawa" },
        { name: "Mróz Logistyka", link: "https://stands.fair.example/mroz", place: "Łódź" },
      ].map((company) => ({ line: null, quote: null, ...company })),
    },
    page,
  );
  assert.deepEqual(
    gated.companies.map(({ domain }) => domain),
    [null, null],
  );
  assert.deepEqual(gated.refused, { link: 2 });
  await run.named(1, [...gated.companies], page.url);
  search.seedResults('"Chłodnia Nord" Warszawa', [
    { url: "https://chlodnia-nord.example/", title: "Chłodnia Nord", snippet: "" },
  ]);
  search.seedResults('"Mróz Logistyka" Łódź', [
    { url: "https://mroz-logistyka.example/", title: "Mróz Logistyka", snippet: "" },
  ]);
  assert.deepEqual(await run.make(1), { status: "made", made: 2 });
  assert.deepEqual(
    search.recordedCalls.map(({ input }) => (input as { query: string }).query),
    ['"Chłodnia Nord" Warszawa', '"Mróz Logistyka" Łódź'],
  );
  assert.deepEqual(
    (await kestrel.rows()).map(({ domain }) => domain),
    ["chlodnia-nord.example", "mroz-logistyka.example"],
  );
});

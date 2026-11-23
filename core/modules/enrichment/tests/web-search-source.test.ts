// The source web-search (gamma-en-070; README "Sources", docs/concepts.md "A company known only by
// name"): the name rules, the picks and the lists in code; then the source on the web-search fake and
// a second fake adapter, its counters on this file's schema: the queries, the name quoted and fixed
// words only, at most two, each only for a field still wanted; a name that is no company searching
// nothing; each search counted under `web-search/<adapter>`, passed on to the next adapter when one
// is spent or fails for any reason, and with none left `allowance_spent` or the last failure; the
// adapter that answered named as the provider; and no name, query or link in a log line.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, isAppError } from "@whytide/platform";
import {
  createFake,
  defineAdapter,
  getAdapter,
  type WebResult,
  type WebSearchFake,
  webSearchPort,
} from "@whytide/providers";
import { useLog } from "../domain/log.ts";
import type { SourceInput } from "../domain/sources/define.ts";
import { NOT_A_COMPANY_NAMES } from "../domain/sources/web-search/constants.ts";
import { webSearchSource } from "../domain/sources/web-search/index.ts";
import { cleanName, isNotACompany } from "../domain/sources/web-search/names.ts";
import {
  isNotAHomepage,
  pickLinkedinPage,
  pickWebsite,
} from "../domain/sources/web-search/pick.ts";
import { useClock, useEnrichmentClient, useWebSearchAdapters } from "../testing/index.ts";

withTestDb();
useEnrichmentClient(asRole("app"));
useClock(() => new Date("2026-11-13T10:00:00Z"));
const logs = collectLogs();
useLog(createLogger({ destination: logs.destination }));
const fake = (await getAdapter(webSearchPort, "fake")) as unknown as WebSearchFake;

/** A second adapter: an answer given per test, its calls recorded. */
const second = createFake(webSearchPort, {
  state: () => ({ results: [] as WebResult[] }),
  methods: (self) => ({
    searchWeb: async () => ({ results: structuredClone(self.state.results) }),
  }),
});
defineAdapter(webSearchPort, { name: "second", create: () => second });

const NAME = "Copper Harbor Labs";
const PAGE_QUERY = `"${NAME}"`;
const SITE_QUERY = `"${NAME}" official website`;
const result = (url: string, title: string): WebResult => ({ url, title, snippet: "Ships." });
const PAGE = result("https://www.linkedin.com/company/copper-harbor/", `${NAME} | LinkedIn`);
const HOME = result("https://www.copperharborlabs.example/", "Copper Harbor Labs: charts");
const input = (more: Partial<SourceInput> = {}): SourceInput => ({
  workspaceId: "wsp_web_search",
  companyId: null,
  company: { name: NAME },
  wanted: ["linkedinUrl", "domain"],
  ...more,
});
const ask = (more?: Partial<SourceInput>) =>
  webSearchSource.run(input(more), { tenant: (fn) => fn() });
const usage = () =>
  asRole("owner").sourceUsage.findMany({
    select: { source: true, used: true, spent: true },
    orderBy: { source: "asc" },
  });
const queries = (calls: typeof fake.recordedCalls) => calls.map(({ input }) => input);
const message = (line: Record<string, unknown>) => String(line.msg ?? "");

beforeEach(() => {
  fake.reset();
  second.reset();
  useWebSearchAdapters(["fake"]);
  logs.raw.length = 0;
});

test("names: compared in lower case, accents folded, punctuation dropped and the legal forms at the end dropped", () => {
  assert.equal(cleanName("Blue Harbor Labs, Ltd."), "blue harbor labs");
  assert.equal(cleanName("  Café   Nord GmbH & Co. KG "), "cafe nord");
  assert.equal(cleanName("O'Reilly Media, Inc."), "oreilly media");
  assert.equal(cleanName("Group"), "group");
  assert.equal(cleanName("Limited Edition Labs"), "limited edition labs");
});

test("a name that is no company: shorter than two characters, or one of NOT_A_COMPANY in any case, accent or punctuation", () => {
  for (const name of NOT_A_COMPANY_NAMES) assert.ok(isNotACompany(name), name);
  for (const name of ["Self-Employed", "SELF EMPLOYED.", "Freelancer", "Stealth Startup", "N/A"]) {
    assert.ok(isNotACompany(name), name);
  }
  for (const name of ["", " ", "X", "-.-", "x".repeat(151)]) assert.ok(isNotACompany(name), name);
  for (const name of ["IO", "Student Loans Co", "Independent Brewing"]) {
    assert.equal(isNotACompany(name), false, name);
  }
});

test("the LinkedIn page: a linkedin.com/company/<slug> result whose title, without its ending, is the name; kept as contacts keys a page", () => {
  const results = [
    result("https://www.linkedin.com/in/someone", `${NAME} | LinkedIn`),
    result("https://www.linkedin.com/company/copper-harbour-ltd", "Copper Harbour | LinkedIn"),
    result(
      "https://uk.linkedin.com/company/Copper-Harbor?trk=x",
      "Copper Harbor Labs Ltd - LinkedIn",
    ),
    result("https://www.linkedin.com/company/copper-harbor/jobs", `${NAME} | LinkedIn`),
    result("https://linkedin.com.evil.example/company/copper-harbor", `${NAME} | LinkedIn`),
  ];
  assert.deepEqual(pickLinkedinPage(NAME, results), {
    found: "https://linkedin.com/company/copper-harbor",
  });
  // The same page twice is one.
  assert.deepEqual(pickLinkedinPage(NAME, [PAGE, ...results]), {
    found: "https://linkedin.com/company/copper-harbor",
  });
  assert.deepEqual(pickLinkedinPage(NAME, results.slice(0, 2)), {
    found: null,
    outcome: "not_found",
  });
});

test("two exact matches with different pages or hosts are ambiguous", () => {
  const other = result("https://www.linkedin.com/company/copper-harbor-labs", `${NAME} | LinkedIn`);
  assert.deepEqual(pickLinkedinPage(NAME, [PAGE, other]), { found: null, outcome: "ambiguous" });
  const twin = result("https://copperharborlabs.example.org/", "Copper Harbor Labs");
  assert.deepEqual(pickWebsite(NAME, [HOME, twin]), { found: null, outcome: "ambiguous" });
});

test("the website: a host whose first label is the name without spaces or starts with it, or whose title starts with the name; the domain lower case without www.; a host and its subdomains one site", () => {
  assert.deepEqual(pickWebsite(NAME, [HOME]), { found: "copperharborlabs.example" });
  const byLabel = result("https://copper-harbor-labs-uk.example/about", "About us");
  assert.deepEqual(pickWebsite(NAME, [byLabel]), { found: "copper-harbor-labs-uk.example" });
  const byTitle = result("https://WWW.CHL.example/", "Copper Harbor Labs Ltd | Home");
  assert.deepEqual(pickWebsite(NAME, [byTitle]), { found: "chl.example" });
  const docs = result("https://docs.copperharborlabs.example/", "Copper Harbor Labs docs");
  assert.deepEqual(pickWebsite(NAME, [docs, HOME]), { found: "copperharborlabs.example" });
  const unrelated = [
    result("https://copper.example/", "Copper prices today"),
    result("https://harbor.example/", "Copper Harbor Laboratories"),
  ];
  assert.deepEqual(pickWebsite(NAME, unrelated), { found: null, outcome: "not_found" });
});

test("a social, directory, news or job host is never chosen as the website", () => {
  const hosts = [
    "https://www.linkedin.com/company/copper-harbor",
    "https://www.facebook.com/copperharborlabs",
    "https://x.com/copperharborlabs",
    "https://en.wikipedia.org/wiki/Copper_Harbor_Labs",
    "https://www.crunchbase.com/organization/copper-harbor-labs",
    "https://www.bloomberg.com/profile/company/copper-harbor-labs",
    "https://www.glassdoor.co.uk/Overview/copper-harbor-labs",
    "https://uk.indeed.com/cmp/Copper-Harbor-Labs",
    "https://www.zoominfo.com/c/copper-harbor-labs/1",
    "https://www.dnb.com/business-directory/copper-harbor-labs",
    "https://www.yelp.com/biz/copper-harbor-labs",
  ];
  const results = hosts.map((url) => result(url, `${NAME} | profile`));
  assert.deepEqual(pickWebsite(NAME, results), { found: null, outcome: "not_found" });
  for (const url of hosts) assert.ok(isNotAHomepage(new URL(url).hostname), url);
  assert.equal(isNotAHomepage("copperharborlabs.example"), false);
});

test("on the fake: two searches, the name quoted on linkedin.com and with fixed words, 5 results each, nothing of the person; the page and the domain found, stamped with the adapter, each search counted", async () => {
  fake.seedResults(PAGE_QUERY, [PAGE]);
  fake.seedResults(SITE_QUERY, [HOME]);
  const answer = await ask({ person: { locationText: "Berlin, Germany" } });
  assert.deepEqual(answer, {
    found: true,
    facts: {
      linkedinUrl: "https://linkedin.com/company/copper-harbor",
      domain: "copperharborlabs.example",
    },
    provider: "fake",
  });
  assert.deepEqual(queries(fake.recordedCalls), [
    { query: PAGE_QUERY, site: "linkedin.com", count: 5 },
    { query: SITE_QUERY, count: 5 },
  ]);
  assert.deepEqual(await usage(), [{ source: "web-search/fake", used: 2, spent: false }]);
  assert.deepEqual(webSearchSource.provenance, { source: "web_search", provider: "web-search" });

  // Only the fields still wanted are searched for.
  fake.reset();
  fake.seedResults(SITE_QUERY, [HOME]);
  const website = await ask({ wanted: ["domain"] });
  assert.deepEqual(website, {
    found: true,
    facts: { domain: "copperharborlabs.example" },
    provider: "fake",
  });
  assert.deepEqual(queries(fake.recordedCalls), [{ query: SITE_QUERY, count: 5 }]);
});

test("Self-employed and the rest of NOT_A_COMPANY make no search: not_a_company", async () => {
  for (const name of ["Self-employed", "Stealth startup", "Open to work", "X"]) {
    assert.deepEqual(await ask({ company: { name } }), {
      found: false,
      outcome: "not_a_company",
    });
  }
  assert.equal(fake.recordedCalls.length, 0);
  assert.deepEqual(await usage(), []);
});

test("no match is not_found and an ambiguous search writes nothing: ambiguous, over not_found", async () => {
  assert.deepEqual(await ask(), { found: false, outcome: "not_found" });
  const other = result("https://www.linkedin.com/company/chl", `${NAME} | LinkedIn`);
  fake.seedResults(PAGE_QUERY, [PAGE, other]);
  assert.deepEqual(await ask(), { found: false, outcome: "ambiguous" });
});

test("a spent allowance skips the adapter with no call: the next adapter is asked, and with every adapter spent the outcome is allowance_spent and no second search is made", async () => {
  useWebSearchAdapters(["fake", "second"]);
  fake.setAllowance({ calls: 1, per: "month" });
  fake.seedResults(PAGE_QUERY, [PAGE]);
  second.state.results = [PAGE];
  const answer = await ask({ wanted: ["linkedinUrl"] });
  assert.deepEqual(answer, {
    found: true,
    facts: { linkedinUrl: "https://linkedin.com/company/copper-harbor" },
    provider: "fake",
  });
  // fake has spent its month's call: second answers the page, and the website's search too.
  const next = await ask();
  assert.deepEqual(next, {
    found: true,
    facts: { linkedinUrl: "https://linkedin.com/company/copper-harbor" },
    provider: "second",
  });
  assert.equal(fake.recordedCalls.length, 1);
  assert.equal(second.recordedCalls.length, 2);

  useWebSearchAdapters(["fake"]);
  const spent = await ask();
  assert.deepEqual(spent, { found: false, outcome: "allowance_spent" });
  assert.equal(fake.recordedCalls.length, 1);
  assert.deepEqual(await usage(), [
    { source: "web-search/fake", used: 1, spent: false },
    { source: "web-search/second", used: 2, spent: false },
  ]);
});

test("an adapter whose search fails for any reason passes it to the next; the vendor's spent word marks its counter spent; with none left the source fails with the last error's code, with no name, query or link in a log line", async () => {
  useWebSearchAdapters(["fake", "second"]);
  second.state.results = [HOME];
  for (const code of [
    "web_search_unauthorized",
    "web_search_rate_limited",
    "web_search_provider_error",
  ] as const) {
    fake.failNext(code);
    const answer = await ask({ wanted: ["domain"] });
    assert.deepEqual(
      answer,
      { found: true, facts: { domain: "copperharborlabs.example" }, provider: "second" },
      code,
    );
  }
  fake.answerNext("searchWeb", new Error("bug"));
  assert.equal((await ask({ wanted: ["domain"] })).found, true);
  const warned = logs
    .lines()
    .filter((line) => message(line).startsWith("enrichment: a web search"));
  assert.deepEqual(
    warned.map(({ provider, code }) => [provider, code]),
    [
      ["web-search/fake", "web_search_unauthorized"],
      ["web-search/fake", "web_search_rate_limited"],
      ["web-search/fake", "web_search_provider_error"],
      ["web-search/fake", "web_search_error_unmapped"],
    ],
  );

  fake.failNext("web_search_allowance_spent");
  assert.equal((await ask({ wanted: ["domain"] })).found, true);
  const calls = fake.recordedCalls.length;
  assert.equal((await ask({ wanted: ["domain"] })).found, true);
  assert.equal(fake.recordedCalls.length, calls, "spent by the vendor's word: no call");
  const counters = await usage();
  assert.deepEqual(counters[0], { source: "web-search/fake", used: 5, spent: true });

  // second fails, fake is spent: none left, and no second search follows.
  useWebSearchAdapters(["second", "fake"]);
  const before = second.recordedCalls.length;
  second.failNext("web_search_rate_limited");
  await assert.rejects(
    ask(),
    (error) => isAppError(error) && error.code === "web_search_rate_limited",
  );
  assert.equal(second.recordedCalls.length, before + 1);

  const text = logs.raw.join("\n");
  for (const value of [
    "Copper",
    "copper",
    "official website",
    "linkedin.com/company",
    ".example",
  ]) {
    assert.ok(!text.includes(value), `the log holds "${value}"`);
  }
});

test("no adapter loaded: no_adapter, no search; one that cannot load is left out with one warning", async () => {
  useWebSearchAdapters([]);
  assert.deepEqual(await ask(), { found: false, outcome: "no_adapter" });
  useWebSearchAdapters(["nope", "fake"]);
  fake.seedResults(PAGE_QUERY, [PAGE]);
  assert.equal((await ask({ wanted: ["linkedinUrl"] })).found, true);
  const warned = logs
    .lines()
    .filter((line) => message(line).startsWith("enrichment: names left out"));
  assert.deepEqual(
    warned.map(({ variable, details }) => [variable, details]),
    [["PROVIDER_WEB_SEARCH", [{ provider: "nope", reason: "provider_unknown" }]]],
  );
});

test("the test for a company's website is public: index.ts exports pickWebsite, domainOf, isNotAHomepage and Picked from the source's own file, which signals' research run applies (gamma-wr-046)", async () => {
  // index.ts mounts the api (decorators), which a test run on source files cannot load: its text is read.
  const index = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const line = /export \{([^}]*)\} from "\.\/domain\/sources\/web-search\/pick\.ts"/u.exec(index);
  const names = (line?.[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  assert.deepEqual(
    names.sort(),
    ["type Picked", "domainOf", "isNotAHomepage", "pickWebsite"].sort(),
  );
  assert.equal(isNotAHomepage("www.facebook.com"), true);
  assert.equal(isNotAHomepage("copperharborlabs.example"), false);
});

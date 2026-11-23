// The pick among a search's results (README.md "Web research"; gamma-wr-045) on the worktree's database,
// the LLM fake and the files fake: two made-up businesses in two countries and two languages each have
// the results of a search answered with the ones worth reading, the likeliest first, kept under
// raw/signals/<runId>/pick/; a result on LinkedIn, on a social network or off http and https is dropped
// in code before the model sees it, counted; the member's words reach the model as labelled data with
// no email address, link or phone number; a number the model picks that is no result is refused by the
// gate and asked again once, then the search's pages are not read and the failure is counted; a pick
// is cut to the likeliest few; a step run again answers from its file with no second call; a query
// never asked has no pick.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

process.env.PROVIDER_LLM = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.COST_PRICES_JSON = JSON.stringify({
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
});
const { loadAgentTasks } = await import("@whytide/ai");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { servicePrincipal } = await import("@whytide/platform");
const { filesConfig, filesPort, getAdapter, llmPort } = await import("@whytide/providers");
const { PICKS_PER_SEARCH } = await import("../domain/research/constants.ts");
const { pickKey, readJsonFile } = await import("../domain/research/files.ts");
const { pickResearchResults } = await import("../domain/research/pick.ts");
const { searchKey } = await import("../domain/research/search.ts");
const { writeRunFile } = await import("../domain/runs.ts");
const { createResearchPlan, createSignalRun, createSignalSource, useSignalsClient } = await import(
  "../testing/index.ts"
);

type Llm = import("@whytide/providers").LlmFake;
type Files = { reset(): void };
withTestDb();
const app = asRole("app");
useSignalsClient(app);
await loadAgentTasks([new URL("../agents/research-pick-results/task.ts", import.meta.url).href]);
const llm = (await getAdapter(llmPort, "fake")) as unknown as Llm;
const files = (await getAdapter(filesPort, filesConfig.PROVIDER_FILES)) as unknown as Files;
const principal = servicePrincipal("signals_test");
const tenantOf =
  (workspaceId: string) =>
  <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
beforeEach(() => {
  llm.reset();
  files.reset();
});

/** Two made-up businesses, each with its words, its country, its language and its search's results. */
const BUSINESSES = {
  kestrel: {
    focus: "chilled-food distributors that need records, write to ops@kestrel.example",
    country: "PL",
    language: "pl",
    query: "rejestratory temperatury dystrybutor",
    place: "web_search",
    results: [
      ["https://chlodnia-nord.example/o-nas", "Chłodnia Nord: dystrybucja żywności"],
      ["https://www.linkedin.com/company/chlodnia-nord", "Chłodnia Nord | LinkedIn"],
      ["https://www.facebook.com/chlodnia", "Chłodnia Nord - Facebook"],
      ["https://mroz-logistyka.example/", "Mróz Logistyka: transport chłodniczy"],
      ["ftp://files.example/list.txt", "A list"],
      ["https://lnkd.in/abc", "Short link"],
    ],
  },
  aurelia: {
    focus: "installers of rooftop solar, call +56 2 2345 6789",
    country: "CL",
    language: "es",
    query: "asociacion energia solar socios",
    place: "association_members",
    results: [
      ["https://solares-del-sur.example/socios", "Socios de la asociación solar"],
      ["https://instalaciones-andes.example/", "Instalaciones Andes"],
      ["https://x.com/andes", "Andes en X"],
    ],
  },
} as const;
type Tag = keyof typeof BUSINESSES;

/** A workspace with a research source, its run open, its plan of the business's query and its search answered. */
async function searched(tag: Tag, suffix = "") {
  const business = BUSINESSES[tag];
  const workspaceId = `wsp_pick${tag}${suffix}`;
  const { focus } = business;
  const source = await createSignalSource({
    ...{ workspaceId, label: tag, kind: "web_research", config: { focus } },
    senderAccountId: null,
  });
  const run = await createSignalRun({ workspaceId, sourceId: source.id, status: "running" });
  await createResearchPlan({
    ...{ workspaceId, sourceId: source.id, runId: run.id },
    queries: [{ text: business.query, placeId: business.place }],
  });
  const { country, language } = business;
  await app.signalResearchQuery.updateMany({
    where: { sourceId: source.id },
    data: { country, language },
  });
  const results = business.results.map(([url, title]) => ({
    url,
    title,
    snippet: `About ${title}`,
  }));
  const ref = { workspaceId, sourceId: source.id, runId: run.id };
  await writeRunFile(workspaceId, searchKey(run.id, 1), {
    ...{ placeId: business.place, country, language, adapter: "fake" },
    results,
  });
  const step = (position = 1) => pickResearchResults(ref, position, tenantOf(workspaceId));
  const counts = async () =>
    ((await app.signalRun.findFirstOrThrow({ where: { id: run.id } })).counts ?? {}) as Record<
      string,
      number
    >;
  /** The pick's file; `queryId`, the query's row (gamma-wr-051), is checked here and left out of the comparisons. */
  const kept = async () => {
    const file = (await readJsonFile(workspaceId, pickKey(run.id, 1))) as {
      queryId?: string;
    } | null;
    if (file === null) return null;
    const { queryId, ...rest } = file;
    const query = await app.signalResearchQuery.findFirstOrThrow({
      where: { sourceId: source.id },
    });
    assert.equal(queryId, query.id);
    return rest;
  };
  return { ref, step, counts, kept, workspaceId };
}
type Recorded = { messages: { content: { text: string }[] }[] };
const sent = (call = 0) => {
  const { messages } = llm.recordedCalls[call]?.input as Recorded;
  return messages.flatMap((message) => message.content.map((part) => part.text)).join("\n");
};

test("two businesses in two countries and two languages: the results of a search are dropped in code when on LinkedIn, a social network or off http and https, the rest go to the model as labelled data with the member's words scrubbed, and the picks, the likeliest first, are kept under the run's pick folder with the search's source type", async () => {
  const kestrel = await searched("kestrel");
  // The model sees the three results left, numbered 1 to 3, and picks the third, then the first.
  llm.script({ picks: [{ index: 2 }, { index: 1 }] });
  assert.deepEqual(await kestrel.step(), { status: "picked", picked: 2 });
  assert.deepEqual(await kestrel.kept(), {
    placeId: "web_search",
    urls: ["https://mroz-logistyka.example/", "https://chlodnia-nord.example/o-nas"],
  });
  assert.deepEqual(await kestrel.counts(), { pages_picked: 2, results_dropped: 4 });
  const text = sent();
  for (const block of ["source", "query", "place", "results"]) {
    assert.ok(text.includes(`<${block}>`), `no ${block} block`);
  }
  for (const dropped of ["linkedin.com", "facebook.com", "lnkd.in", "ftp://"]) {
    assert.ok(!text.includes(dropped), `the call holds ${dropped}`);
  }
  assert.ok(text.includes("chlodnia-nord.example") && text.includes("mroz-logistyka.example"));
  assert.ok(!text.includes("ops@kestrel.example") && text.includes("[email]"));

  const aurelia = await searched("aurelia");
  llm.script({ picks: [{ index: 1 }, { index: 2 }] });
  assert.deepEqual(await aurelia.step(), { status: "picked", picked: 2 });
  assert.deepEqual(await aurelia.kept(), {
    placeId: "association_members",
    urls: ["https://solares-del-sur.example/socios", "https://instalaciones-andes.example/"],
  });
  assert.deepEqual(await aurelia.counts(), { pages_picked: 2, results_dropped: 1 });
  const other = sent(1);
  assert.ok(!other.includes("+56 2 2345 6789") && other.includes("[phone]"));
  assert.ok(!other.includes("x.com"));
});

test("a number the model picks that is no result is refused by the gate and the model is asked again once; a second refusal ends the pick failed with nothing kept and counted, and a number twice is refused too", async () => {
  const run = await searched("aurelia", "gate");
  llm.script({ picks: [{ index: 9 }] }, { picks: [{ index: 1 }, { index: 1 }] });
  assert.deepEqual(await run.step(), { status: "failed" });
  assert.equal(llm.recordedCalls.length, 2);
  assert.equal(await run.kept(), null);
  assert.deepEqual(await run.counts(), { picks_failed: 1 });
  llm.reset();
  const again = await searched("aurelia", "gateretry");
  llm.script({ picks: [{ index: 3 }, { index: 4 }] }, { picks: [{ index: 2 }] });
  assert.deepEqual(await again.step(), { status: "picked", picked: 1 });
  assert.equal(llm.recordedCalls.length, 2);
  assert.ok(sent(1).includes("validation_error"), "the retry does not carry the failure");
  assert.deepEqual(await again.kept(), {
    placeId: "association_members",
    urls: ["https://instalaciones-andes.example/"],
  });
});

test("a pick keeps the likeliest few only, a search whose results all drop is picked with no call to the model, and a model that picks none keeps none", async () => {
  const many = await searched("kestrel", "many");
  const urls = Array.from({ length: 12 }, (_, at) => `https://firm-${at + 1}.example/`);
  await writeRunFile(many.workspaceId, searchKey(many.ref.runId, 1), {
    results: urls.map((url) => ({ url, title: "Firm", snippet: "" })),
  });
  llm.script({ picks: urls.map((_, at) => ({ index: at + 1 })) });
  assert.deepEqual(await many.step(), { status: "picked", picked: PICKS_PER_SEARCH });
  assert.deepEqual(
    ((await many.kept()) as { urls: string[] }).urls,
    urls.slice(0, PICKS_PER_SEARCH),
  );

  const closed = await searched("kestrel", "closed");
  await writeRunFile(closed.workspaceId, searchKey(closed.ref.runId, 1), {
    results: [{ url: "https://www.linkedin.com/company/a", title: "A | LinkedIn", snippet: "" }],
  });
  const asked = llm.recordedCalls.length;
  assert.deepEqual(await closed.step(), { status: "picked", picked: 0 });
  assert.equal(llm.recordedCalls.length, asked, "the model saw a LinkedIn result");
  assert.deepEqual(await closed.counts(), { results_dropped: 1 });

  const none = await searched("aurelia", "none");
  llm.script({ picks: [] });
  assert.deepEqual(await none.step(), { status: "picked", picked: 0 });
  assert.deepEqual(await none.kept(), { placeId: "association_members", urls: [] });
});

test("a step run again answers from its file with no second call and no second count; a query never asked has no answer file and no pick; a source gone is gone", async () => {
  const run = await searched("kestrel", "again");
  llm.script({ picks: [{ index: 1 }] });
  assert.deepEqual(await run.step(), { status: "picked", picked: 1 });
  assert.deepEqual(await run.step(), { status: "picked", picked: 1 });
  assert.equal(llm.recordedCalls.length, 1);
  assert.deepEqual(await run.counts(), { pages_picked: 1, results_dropped: 4 });
  assert.deepEqual(await run.step(2), { status: "none" });
  const gone = await searched("kestrel", "gone");
  await app.signalSource.deleteMany({ where: { id: gone.ref.sourceId } });
  assert.deepEqual(await gone.step(), { status: "gone" });
});

// The research run's plan (README.md "Web research"; gamma-wr-040) on the worktree's database and the
// LLM fake: two made-up businesses in two countries and two languages each get a plan from what their
// member gave in the app, kept with its queries in the plan's order, the model's input holding the
// member's words as labelled data and no email address, link or phone number; a source type off the
// list, a country outside the audience's, a language outside the source's, a blank or too long query, a
// query asked within the re-check days and a repeat are each refused by their gate and the rest is
// kept; a source's edit changes the next plan's input; a second run asks none of the first run's
// queries, until the re-check days pass; a plan that fails twice ends `failed`; a step run again finds
// its plan and asks no second time.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

process.env.PROVIDER_LLM = "fake";
process.env.COST_PRICES_JSON = JSON.stringify({
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
});
const { loadAgentTasks } = await import("@whytide/ai");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { readIcpForScoring } = await import("@whytide/icp");
const { newId, servicePrincipal } = await import("@whytide/platform");
const { getAdapter, llmPort } = await import("@whytide/providers");
const { gatePlan, queryKey } = await import("../domain/research/checks.ts");
const { PLAN_GATES } = await import("../domain/research/constants.ts");
const { planResearchRun } = await import("../domain/research/plan.ts");
const { listPlaces } = await import("../domain/research/places/registry.ts");
const {
  createFoundCompany,
  createResearchCandidate,
  createSignalRun,
  createSignalSource,
  useSignalsClient,
} = await import("../testing/index.ts");
const { LANGUAGES } = await import("../sources/web_research/constants.ts");

type Llm = import("@whytide/providers").LlmFake;
type Output = import("../schemas/research-plan.ts").ResearchPlanOutput;
withTestDb();
const app = asRole("app");
useSignalsClient(app);
await loadAgentTasks([new URL("../agents/research-plan/task.ts", import.meta.url).href]);
const llm = (await getAdapter(llmPort, "fake")) as unknown as Llm;
const principal = servicePrincipal("signals_test");
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });
const tenantOf =
  (workspaceId: string) =>
  <T>(fn: () => Promise<T>) =>
    inRun(workspaceId, fn);
const DAY_MS = 86_400_000;
beforeEach(() => llm.reset());

/** Two made-up businesses: what their members gave in the app, each in its own country and language. */
const BUSINESSES = {
  kestrel: {
    focus: "chilled-food distributors that need temperature records for their trucks",
    region: "Mazovia",
    languages: ["pl"],
    countries: ["PL"],
    oneLiner: "Temperature loggers for refrigerated transport. Write to ops@kestrel.example",
    products: ["Cold-chain data logger", "Fleet dashboard"],
    painPoints: ["Spoiled loads", "Audit paperwork"],
    competitors: ["Frostline Systems"],
    queries: [
      { place: "web_search", text: "rejestratory temperatury transport chłodniczy dystrybutor" },
      { place: "fair_exhibitors", text: "lista wystawców targi logistyka żywności chłodniczej" },
    ],
  },
  aurelia: {
    focus: "installers of rooftop solar who buy mounting rails",
    region: "",
    languages: [],
    countries: ["CL", "PE"],
    oneLiner:
      "Aluminium mounts for rooftop solar. Call +56 2 2345 6789 or see https://aurelia.example",
    products: ["Rail kit"],
    painPoints: ["Slow installs"],
    competitors: [],
    queries: [
      { place: "association_members", text: "asociación energía solar socios instaladores" },
      { place: "public_tenders", text: "licitación instalación paneles solares techo" },
    ],
  },
} as const;
type Slug = keyof typeof BUSINESSES;

/** A workspace with the business's Company Knowledge, audience and one research source, its run open. */
async function businessIn(slug: Slug, tag = slug as string) {
  const business = BUSINESSES[slug];
  const workspaceId = `wsp_${tag}`;
  const { oneLiner, products, painPoints, competitors } = business;
  const knowledge = { oneLiner, products: [...products], painPoints: [...painPoints] };
  await app.companyKnowledge.create({
    data: { id: newId("ck"), workspaceId, ...knowledge, competitors: [...competitors] },
  });
  const { icp } = await inRun(workspaceId, () => readIcpForScoring(workspaceId));
  const countries = [...business.countries];
  const targeting = { countries, titles: ["Purchasing manager"] };
  await app.icp.update({ where: { id: icp.id }, data: targeting });
  const config = { focus: business.focus, languages: [...business.languages] };
  const region = business.region === "" ? {} : { region: business.region };
  const source = await createSignalSource({
    workspaceId,
    label: tag,
    kind: "web_research",
    config: { ...config, ...region },
    senderAccountId: null,
  });
  return { workspaceId, sourceId: source.id, business };
}
const runOf = async (workspaceId: string, sourceId: string) => {
  const run = await createSignalRun({ workspaceId, sourceId, status: "running" });
  return { workspaceId, sourceId, runId: run.id };
};
const planOf = (
  country: string,
  language: string,
  queries: readonly { place: string; text: string }[],
) =>
  ({
    words: [{ language, words: ["alpha", "beta"] }],
    places: [...new Set(queries.map(({ place }) => place))],
    queries: queries.map((query) => ({ ...query, country, language })),
  }) satisfies Output;
type Recorded = { messages: { content: { text: string }[] }[] };
const sent = (call = 0) => {
  const { messages } = llm.recordedCalls[call]?.input as Recorded;
  return messages.flatMap((message) => message.content.map((part) => part.text)).join("\n");
};

test("two businesses in two countries and two languages each get a plan: its words by language, its source types and its queries in the plan's order, with their country and language, the counts on the run; the model reads the member's words as labelled data, an email address, a link and a phone number as placeholders", async () => {
  const kestrel = await businessIn("kestrel");
  const first = await runOf(kestrel.workspaceId, kestrel.sourceId);
  llm.script(planOf("PL", "pl", kestrel.business.queries));
  const planned = await planResearchRun(first, tenantOf(first.workspaceId));
  assert.deepEqual(planned, { status: "planned", queries: 2, refused: 0 });
  const plan = await app.signalResearchPlan.findFirstOrThrow({ where: { runId: first.runId } });
  assert.deepEqual(plan.words, [{ language: "pl", words: ["alpha", "beta"] }]);
  assert.deepEqual(plan.placeIds, ["web_search", "fair_exhibitors"]);
  assert.ok(plan.decisionRecordId !== null);
  const queries = await app.signalResearchQuery.findMany({
    where: { planId: plan.id },
    orderBy: { position: "asc" },
  });
  assert.deepEqual(
    queries.map(({ position, placeId, country, language, text, askedAt, resultCount }) => [
      ...[position, placeId, country, language, text],
      ...[askedAt, resultCount],
    ]),
    kestrel.business.queries.map(({ place, text }, at) => [
      at + 1,
      place,
      "PL",
      "pl",
      text,
      null,
      null,
    ]),
  );
  const row = await app.signalRun.findUniqueOrThrow({ where: { id: first.runId } });
  assert.deepEqual(row.counts, { queries_planned: 2 });
  const text = sent();
  for (const block of ["knowledge", "audience", "source", "places", "asked"]) {
    assert.ok(text.includes(`<${block}>`), `no ${block} block`);
  }
  assert.ok(text.includes(kestrel.business.focus), "the source's focus is not in the call");
  for (const value of ["ops@kestrel.example", "kestrel.example"]) {
    assert.ok(!text.includes(value), `the call holds ${value}`);
  }
  assert.ok(text.includes("[email]"));

  const aurelia = await businessIn("aurelia");
  const second = await runOf(aurelia.workspaceId, aurelia.sourceId);
  llm.script(planOf("CL", "es", aurelia.business.queries));
  await planResearchRun(second, tenantOf(second.workspaceId));
  const other = sent(1);
  for (const value of ["+56 2 2345 6789", "https://aurelia.example", "aurelia.example"]) {
    assert.ok(!other.includes(value), `the call holds ${value}`);
  }
  assert.ok(other.includes("[phone]") && other.includes("[link]"));
  const plans = await app.signalResearchPlan.findMany({ orderBy: { createdAt: "asc" } });
  assert.deepEqual(
    plans.map(({ workspaceId }) => workspaceId),
    ["wsp_kestrel", "wsp_aurelia"],
  );
});

test("the model's input holds the nine source types of the list and nothing about a person", async () => {
  const { workspaceId, sourceId } = await businessIn("kestrel", "input");
  llm.script(planOf("PL", "pl", BUSINESSES.kestrel.queries));
  await planResearchRun(await runOf(workspaceId, sourceId), tenantOf(workspaceId));
  const text = sent();
  for (const { id } of listPlaces()) assert.ok(text.includes(id), `${id} is not in the call`);
  assert.ok(listPlaces().length >= 9);
  assert.ok(
    !/@|linkedin\.com/.test(text.replace(/\[email\]/g, "")),
    "an address or a profile link",
  );
});

test("the gates refuse a source type off the list, a country outside the audience's, a language outside the source's, a blank query and one over the port's length, a query asked within the re-check days and a repeat, each counted by its gate, and the rest of the plan is kept", async () => {
  const { workspaceId, sourceId } = await businessIn("kestrel", "gates");
  const now = new Date();
  const earlier = await runOf(workspaceId, sourceId);
  const old = await app.signalResearchPlan.create({
    data: {
      id: newId("rpl"),
      workspaceId,
      sourceId,
      runId: earlier.runId,
      words: [],
      placeIds: [],
    },
  });
  await app.signalResearchQuery.create({
    data: {
      ...{ id: newId("rqy"), workspaceId, planId: old.id, sourceId, position: 1 },
      ...{
        placeId: "web_search",
        country: "PL",
        language: "pl",
        text: "Zapytanie  sprzed tygodnia",
      },
      askedAt: new Date(now.getTime() - 7 * DAY_MS),
      resultCount: 10,
    },
  });
  const ok = (text: string, place = "web_search") => ({
    place,
    country: "PL",
    language: "pl",
    text,
  });
  const output: Output = {
    words: [
      { language: "pl", words: ["rejestrator", " Rejestrator ", "", "czujnik"] },
      { language: "de", words: ["Datenlogger"] },
    ],
    places: ["fair_exhibitors", "no_such_place", "fair_exhibitors"],
    queries: [
      ok("pierwsze zapytanie"),
      ok("zapytanie w złym miejscu", "no_such_place"),
      { ...ok("query in the wrong country"), country: "DE" },
      { ...ok("Anfrage in der falschen Sprache"), language: "de" },
      ok("   "),
      ok("x".repeat(201)),
      ok("zapytanie sprzed tygodnia"),
      ok("zapytanie   sprzed tygodnia", "fair_exhibitors"),
      ok("pierwsze  zapytanie"),
      ok("drugie zapytanie", "association_members"),
    ],
  };
  llm.script(output);
  const run = await runOf(workspaceId, sourceId);
  const planned = await planResearchRun(run, tenantOf(workspaceId), now);
  // The one asked a week ago is told to the model as asked; the same text with its spaces squeezed
  // and its case changed is refused by the gate whichever source type it names.
  assert.ok(
    sent().includes("Zapytanie  sprzed tygodnia") || sent().includes("Zapytanie sprzed tygodnia"),
  );
  const plan = await app.signalResearchPlan.findFirstOrThrow({ where: { runId: run.runId } });
  const kept = await app.signalResearchQuery.findMany({
    where: { planId: plan.id },
    orderBy: { position: "asc" },
  });
  assert.deepEqual(
    kept.map(({ position, text, placeId }) => [position, text, placeId]),
    [
      [1, "pierwsze zapytanie", "web_search"],
      [2, "drugie zapytanie", "association_members"],
    ],
  );
  assert.deepEqual(plan.words, [{ language: "pl", words: ["rejestrator", "czujnik"] }]);
  assert.deepEqual(plan.placeIds, ["fair_exhibitors", "web_search", "association_members"]);
  assert.deepEqual(plan.refused, {
    ...{ place: 2, country: 1, language: 2, query: 2 },
    ...{ recheck: 2, duplicate: 1 },
  });
  assert.deepEqual(planned, { status: "planned", queries: 2, refused: 10 });
});

test("a source's edit changes the next plan: its fields are read again at each run, and the model is told what the source asked before", async () => {
  const { workspaceId, sourceId } = await businessIn("aurelia", "edit");
  llm.script(
    planOf("CL", "es", BUSINESSES.aurelia.queries),
    planOf("PE", "es", [{ place: "web_search", text: "montantes solares" }]),
  );
  await planResearchRun(await runOf(workspaceId, sourceId), tenantOf(workspaceId));
  assert.ok(sent(0).includes("installers of rooftop solar who buy mounting rails"));
  const edited = { focus: "makers of carports with solar roofs", languages: ["es", "pt"] };
  await app.signalSource.update({ where: { id: sourceId }, data: { config: edited } });
  await planResearchRun(await runOf(workspaceId, sourceId), tenantOf(workspaceId));
  const text = sent(1);
  assert.ok(text.includes("makers of carports with solar roofs"));
  assert.ok(!text.includes("installers of rooftop solar who buy mounting rails"));
  assert.match(text, /"languages": \[\s+"es",\s+"pt"\s+\]/);
});

test("a second run asks none of the first run's queries: the first's, asked, are told to the model and refused again, until the re-check days pass", async () => {
  const { workspaceId, sourceId } = await businessIn("kestrel", "second");
  const plan = planOf("PL", "pl", BUSINESSES.kestrel.queries);
  llm.script(plan, plan, plan);
  const first = await runOf(workspaceId, sourceId);
  await planResearchRun(first, tenantOf(workspaceId));
  const asked = new Date();
  await app.signalResearchQuery.updateMany({
    where: { sourceId },
    data: { askedAt: asked, resultCount: 10 },
  });
  const second = await runOf(workspaceId, sourceId);
  assert.deepEqual(await planResearchRun(second, tenantOf(workspaceId), asked), {
    ...{ status: "planned", queries: 0, refused: 2 },
  });
  const told = sent(1);
  for (const { text } of BUSINESSES.kestrel.queries) assert.ok(told.includes(text), text);
  // Past the default's 180 days the same queries may be asked again.
  const later = new Date(asked.getTime() + 181 * DAY_MS);
  const third = await runOf(workspaceId, sourceId);
  assert.deepEqual(await planResearchRun(third, tenantOf(workspaceId), later), {
    ...{ status: "planned", queries: 2, refused: 0 },
  });
});

test("a plan the model fails twice ends failed with research_plan_failed and keeps nothing; a step run again finds its plan and asks no second time", async () => {
  const { workspaceId, sourceId } = await businessIn("kestrel", "failed");
  const run = await runOf(workspaceId, sourceId);
  llm.script("not JSON", { words: "nothing" });
  assert.deepEqual(await planResearchRun(run, tenantOf(workspaceId)), {
    ...{ status: "failed", code: "research_plan_failed" },
  });
  assert.equal(await app.signalResearchPlan.count({ where: { workspaceId } }), 0);
  llm.reset();
  llm.script(planOf("PL", "pl", BUSINESSES.kestrel.queries));
  const planned = await planResearchRun(run, tenantOf(workspaceId));
  const again = await planResearchRun(run, tenantOf(workspaceId));
  assert.deepEqual(again, planned);
  assert.equal(llm.recordedCalls.length, 1, "the step asked the model twice");
  assert.equal(await app.signalResearchQuery.count({ where: { workspaceId } }), 2);
});

test("a source gone answers gone, and no plan is kept", async () => {
  const { workspaceId } = await businessIn("kestrel", "gone");
  const ref = { workspaceId, sourceId: "src_gone", runId: "run_gone" };
  assert.deepEqual(await planResearchRun(ref, tenantOf(workspaceId)), { status: "gone" });
  assert.equal(llm.recordedCalls.length, 0);
});

test("the gates, one at a time: each refusal is counted by its gate's name and the rest of the answer is kept", () => {
  const bounds = {
    places: new Set(["web_search"]),
    countries: new Set(["PL"]),
    languages: new Set(["pl"]),
    kindLanguages: new Set(LANGUAGES),
    asked: new Set([queryKey("PL", "pl", "asked")]),
    fits: (text: string) => text.length <= 200,
  };
  const q = (over: object) => ({
    place: "web_search",
    country: "PL",
    language: "pl",
    text: "one",
    ...over,
  });
  const refused = (over: object) => gatePlan({ words: [], places: [], queries: [q(over)] }, bounds);
  const cases: [string, object, string | null][] = [
    ["place", { place: "other" }, "place"],
    ["country", { country: "DE" }, "country"],
    ["a country in lower case is the same country", { country: "pl" }, null],
    ["language", { language: "de" }, "language"],
    ["blank", { text: " \n " }, "query"],
    ["long", { text: "y".repeat(201) }, "query"],
    ["asked, spaced and in capitals", { text: "  ASKED " }, "recheck"],
    ["fine", {}, null],
  ];
  for (const [name, over, gate] of cases) {
    const gated = refused(over);
    assert.deepEqual(gated.refused, gate === null ? {} : { [gate]: 1 }, name);
    assert.equal(gated.queries.length, gate === null ? 1 : 0, name);
  }
  // `duplicate` is a repeat in one answer; `role_word` is a role word's, tested with the role words.
  assert.ok(
    PLAN_GATES.every(
      (gate) =>
        cases.some(([, , named]) => named === gate) || gate === "duplicate" || gate === "role_word",
    ),
  );
  // Without a language of the source's, the kind's list bounds it: a code of the standard is kept.
  const open = gatePlan(
    { words: [], places: [], queries: [q({ language: "de" }), q({ language: "zz", text: "two" })] },
    { ...bounds, languages: new Set() },
  );
  assert.deepEqual([open.queries.length, open.refused], [1, { language: 1 }]);
});

test("the plan reads what the source's earlier runs found (prompt version 2): the companies each query and source type led to, by verdict, and the towns and states of the fitting ones, and no company's name, site, line or quote", async () => {
  const { workspaceId, sourceId } = await businessIn("kestrel", "found");
  const plan = planOf("PL", "pl", BUSINESSES.kestrel.queries);
  llm.script(plan, plan);
  const first = await runOf(workspaceId, sourceId);
  await planResearchRun(first, tenantOf(workspaceId));
  const queries = await app.signalResearchQuery.findMany({
    where: { sourceId },
    orderBy: { position: "asc" },
  });
  await app.signalResearchQuery.updateMany({
    where: { sourceId },
    data: { askedAt: new Date(), resultCount: 10 },
  });
  const [one, two] = queries;
  // Four companies of the first query's results, one of the second's, one from a start page.
  const rows: [
    string,
    "fit" | "not_fit" | "unsure",
    string | null,
    string | null,
    string | undefined,
  ][] = [
    ["tulip-one.example", "fit", "Płock", "Mazowieckie", one?.id],
    ["tulip-two.example", "fit", "Płock", "Mazowieckie", one?.id],
    ["tulip-three.example", "not_fit", null, null, one?.id],
    ["tulip-four.example", "unsure", null, null, one?.id],
    ["tulip-five.example", "fit", "Radom", null, two?.id],
    ["tulip-six.example", "fit", null, null, undefined],
  ];
  for (const [domain, verdict, town, state, queryId] of rows) {
    await createFoundCompany({ workspaceId, sourceId, domain, verdict, name: `Firma ${domain}` });
    await app.signalFoundCompany.updateMany({
      where: { sourceId, domain },
      data: {
        town,
        state,
        country: "PL",
        placeId: queryId === one?.id ? "web_search" : "fair_exhibitors",
      },
    });
    const candidate = await createResearchCandidate({ workspaceId, sourceId, domain });
    await app.signalResearchCandidate.update({
      where: { id: candidate.id },
      data: { queryId: queryId ?? null, line: "A secret line", quote: "A secret quote" },
    });
  }
  await planResearchRun(await runOf(workspaceId, sourceId), tenantOf(workspaceId));
  const text = sent(1);
  const block = (name: string) => text.split(`<${name}>`)[1]?.split(`</${name}>`)[0] ?? "";
  const asked = JSON.parse(block("asked")) as {
    text: string;
    found: { fit: number; notFit: number; unsure: number };
  }[];
  const byText = Object.fromEntries(asked.map(({ text, found }) => [text, found]));
  assert.deepEqual(byText[one?.text ?? ""], { fit: 2, notFit: 1, unsure: 1 });
  assert.deepEqual(byText[two?.text ?? ""], { fit: 1, notFit: 0, unsure: 0 });
  assert.deepEqual(JSON.parse(block("found")), {
    places: [
      { place: "fair_exhibitors", fit: 2, notFit: 0, unsure: 0 },
      { place: "web_search", fit: 2, notFit: 1, unsure: 1 },
    ],
    towns: [
      { country: "PL", town: "Płock", state: "Mazowieckie", companies: 2 },
      { country: "PL", town: "Radom", state: null, companies: 1 },
    ],
  });
  for (const word of ["Firma", "tulip", "secret"]) {
    assert.ok(!text.includes(word), `the model's input holds ${word}`);
  }
});

test("the plan reads the source's own Not a fit companies (prompt version 3): a block of their names, hosts and places, the newest mark first, none of another source's, none the run judged not_fit alone; a name with an email address or a link is scrubbed; a source with none gets an empty block (gamma-wr-110)", async () => {
  const { workspaceId, sourceId } = await businessIn("kestrel", "notfit");
  const other = await createSignalSource({
    ...{ workspaceId, label: "Another", kind: "web_research", senderAccountId: null },
    config: { focus: "retailers of loggers" },
  });
  const mark = async (
    source: string,
    domain: string,
    name: string,
    day: number,
    over: { town?: string; country?: string; marked?: boolean } = {},
  ) => {
    const { marked = true, ...place } = over;
    await createFoundCompany({
      workspaceId,
      sourceId: source,
      domain,
      name,
      verdict: "not_fit",
      ...place,
    });
    if (!marked) return;
    await app.signalFoundCompany.updateMany({
      where: { sourceId: source, domain },
      data: {
        ...{ memberMark: "not_fit", memberMarkedBy: "usr_test" },
        memberMarkedAt: new Date(Date.UTC(2026, 10, day)),
      },
    });
  };
  await mark(sourceId, "zielona-dolina.example", "Zielona Dolina Hurt", 2, {
    town: "Płock",
    country: "PL",
  });
  await mark(sourceId, "mazowsze-mrozonki.example", "Mazowsze Mrozonki ops@mrozonki.example", 5);
  await mark(sourceId, "judged-only.example", "Judged Only", 6, { marked: false });
  await mark(other.id, "other-source.example", "Other Source Ltd", 7);
  const plan = planOf("PL", "pl", BUSINESSES.kestrel.queries);
  llm.script(plan, plan);
  await planResearchRun(await runOf(workspaceId, sourceId), tenantOf(workspaceId));
  const text = sent(0);
  const block = (name: string) => text.split(`<${name}>`)[1]?.split(`</${name}>`)[0] ?? "";
  assert.deepEqual(JSON.parse(block("not_fit")), [
    {
      ...{ name: "Mazowsze Mrozonki [email]", domain: "mazowsze-mrozonki.example" },
      country: null,
      town: null,
    },
    { name: "Zielona Dolina Hurt", domain: "zielona-dolina.example", country: "PL", town: "Płock" },
  ]);
  for (const word of ["Other Source", "other-source", "Judged Only", "ops@mrozonki"]) {
    assert.ok(!text.includes(word), `the model's input holds ${word}`);
  }
  // A source with none marked gets an empty block.
  const bare = await businessIn("aurelia", "notfit_bare");
  llm.script(planOf("CL", "es", BUSINESSES.aurelia.queries));
  await planResearchRun(await runOf(bare.workspaceId, bare.sourceId), tenantOf(bare.workspaceId));
  const next = llm.recordedCalls.length - 1;
  const bareText = sent(next);
  assert.deepEqual(
    JSON.parse(bareText.split("<not_fit>")[1]?.split("</not_fit>")[0] ?? "null"),
    [],
  );
});

test("the plan keeps its role words by language, gated: a language off the source's is refused, a word that holds an address is refused and counted, the rest is kept in the plan's order; a plan of an earlier version gives none, kept as an empty list; the model is told the audience's titles to write them from", async () => {
  const kestrel = await businessIn("kestrel", "roles");
  const first = await runOf(kestrel.workspaceId, kestrel.sourceId);
  llm.script({
    ...planOf("PL", "pl", kestrel.business.queries),
    roleWords: [
      {
        language: "pl",
        words: ["kierownik zakupów", "dyrektor logistyki", "pisz do ana@firma.example"],
      },
      { language: "de", words: ["Einkaufsleiter"] },
    ],
  });
  const planned = await planResearchRun(first, tenantOf(first.workspaceId));
  assert.deepEqual(planned, { status: "planned", queries: 2, refused: 2 });
  const plan = await app.signalResearchPlan.findFirstOrThrow({ where: { runId: first.runId } });
  assert.deepEqual(plan.roleWords, [
    { language: "pl", words: ["kierownik zakupów", "dyrektor logistyki"] },
  ]);
  assert.deepEqual(plan.refused, { language: 1, role_word: 1 });
  assert.ok(sent().includes("Purchasing manager"));
  const aurelia = await businessIn("aurelia", "roles-old");
  const second = await runOf(aurelia.workspaceId, aurelia.sourceId);
  llm.script(planOf("CL", "es", aurelia.business.queries));
  await planResearchRun(second, tenantOf(second.workspaceId));
  const old = await app.signalResearchPlan.findFirstOrThrow({ where: { runId: second.runId } });
  assert.deepEqual(old.roleWords, []);
});

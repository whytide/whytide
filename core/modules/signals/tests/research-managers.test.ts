// A found company's managers by search (README.md "Web research"; gamma-wr-090): the query, which result
// is taken, the read's gates and the people the pages gave already in code, then the people step on the
// worktree's database, the LLM fake, the files fake, the search fake and company sites served on 127.0.0.2
// and 127.0.0.3 (hosts the egress client reaches through EGRESS_ALLOW_HOSTS, set before the platform
// loads). Two made-up businesses in two countries and two languages: a Brazilian one (Portuguese) and a
// German one (German). A company whose pages name nobody gets one search for its managers, limited to
// linkedin.com, with its country, its name and the plan's role words as the only words; the results that
// are a profile's and name the company go to the model with no address, the people it reads are gated,
// the pick judges their roles alone and the people picked become leads with those profiles, the evidence
// saying they were found by the managers' search, with the result's title and the company's site. A
// company whose pages gave the limit already, a plan with no role words, the run's searches at their
// limit and every adapter spent ask none; a person on a page and among the results is one lead.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, mock, test } from "node:test";

const HTML = { "content-type": "text/html; charset=utf-8" };
const html = (title: string, body: string, nav = "") =>
  `<!doctype html><html><head><title>${title}</title></head><body>${nav}<main>${body}</main></body></html>`;
const ADDRESS = {
  "frio-aurora.example": "127.0.0.2",
  "kaffee-brandt.example": "127.0.0.3",
} as const;
type Domain = keyof typeof ADDRESS;
const SITE_OF = new Map<string, Domain>(
  (Object.entries(ADDRESS) as [Domain, string][]).map(([name, ip]) => [ip, name]),
);
const FILLER = "Made-up filler about the business. ".repeat(5);
const pad = (text: string) => `<p>${text}</p><p>${FILLER}</p>`;
const nav = `<nav><a href="/team">Team</a></nav>`;
const pages: Record<Domain, Record<string, string>> = {
  "frio-aurora.example": {
    "/": html("Frio Aurora Ltda", pad("A Frio Aurora vende câmaras frigoríficas."), nav),
    "/team": html(
      "Equipe",
      pad(
        "Marina Tavares, Diretora Comercial. marina.tavares@frio-aurora.example. Escritório de Curitiba, Brasil.",
      ),
    ),
  },
  "kaffee-brandt.example": {
    "/": html("Kaffee Brandt", pad("Kaffee Brandt röstet Kaffee für Cafés."), nav),
    "/team": html(
      "Team",
      pad(
        "<ul>" +
          "<li>Jonas Weber, Geschäftsführer. jonas.weber@kaffee-brandt.example</li>" +
          "<li>Anna Schmidt, Leiterin Einkauf. anna.schmidt@kaffee-brandt.example</li>" +
          "<li>Lena Vogt, Vertriebsleiterin. lena.vogt@kaffee-brandt.example</li>" +
          "<li>Mia Keller, Einkaufsleiterin. mia.keller@kaffee-brandt.example</li>" +
          "</ul>",
      ),
    ),
  },
};
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const ip = (req.headers.host ?? "").split(":")[0] ?? "";
  const domain = SITE_OF.get(ip);
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (path === "/robots.txt") {
    res.writeHead(404, { "content-type": "text/plain" }).end("");
    return;
  }
  const page = domain === undefined ? undefined : pages[domain][path];
  if (page === undefined) res.writeHead(404).end("not found");
  else res.writeHead(200, HTML).end(page);
});
await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
const { port } = server.address() as AddressInfo;
// The platform's egress config reads it as it loads, below.
process.env.EGRESS_ALLOW_HOSTS = Object.values(ADDRESS)
  .map((ip) => `${ip}:${port}`)
  .join(",");
after(() => {
  server.closeAllConnections();
  server.close();
});

process.env.PROVIDER_LLM = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.SIGNALS_RESEARCH_COMPANIES_PER_RUN = "5";
process.env.SIGNALS_RESEARCH_SITE_MAX_PAGES = "3";
process.env.SIGNALS_RESEARCH_PEOPLE_PER_COMPANY = "4";
process.env.SIGNALS_RESEARCH_SEARCHES_PER_RUN = "3";
process.env.COST_PRICES_JSON = JSON.stringify({
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
});
const { loadAgentTasks } = await import("@whytide/ai");
const { useHashSalt } = await import("@whytide/contacts/testing");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { useEnrichmentClient, useSiteHome, useWebSearchAdapters } = await import(
  "@whytide/enrichment/testing"
);
const { readIcpForScoring } = await import("@whytide/icp");
const { servicePrincipal } = await import("@whytide/platform");
const { filesConfig, filesPort, getAdapter, llmPort, webSearchPort } = await import(
  "@whytide/providers"
);
const { managersKey, readJsonFile } = await import("../domain/research/files.ts");
const { gatePlan } = await import("../domain/research/checks.ts");
const {
  gateManagers,
  managerResultsOf,
  managersQuery,
  roleWordsOf,
  withoutPagePeople,
  wordsForSearch,
} = await import("../domain/research/managers-checks.ts");
const { queuePeople, takePeople } = await import("../domain/research/people.ts");
const { useClient } = await import("../domain/client.ts");
const { createFoundCompany, createResearchPlan, createSignalRun, createSignalSource } =
  await import("../testing/index.ts");

type Llm = import("@whytide/providers").LlmFake;
type Files = { reset(): void };
type Search = import("@whytide/providers").WebSearchFake;
withTestDb();
const app = asRole("app");
useClient(app);
useEnrichmentClient(app);
useHashSalt("test-salt-".repeat(4));
useSiteHome((domain) => new URL(`http://${ADDRESS[domain as Domain]}:${port}/`));
await loadAgentTasks([
  new URL("../agents/research-read-people/task.ts", import.meta.url).href,
  new URL("../agents/research-pick-people/task.ts", import.meta.url).href,
  new URL("../agents/research-read-result/task.ts", import.meta.url).href,
]);
const llm = (await getAdapter(llmPort, "fake")) as unknown as Llm;
const files = (await getAdapter(filesPort, filesConfig.PROVIDER_FILES)) as unknown as Files;
const search = (await getAdapter(webSearchPort, "fake")) as unknown as Search;
const principal = servicePrincipal("signals_test");
const tenantOf =
  (workspaceId: string) =>
  <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
beforeEach(() => {
  llm.reset();
  files.reset();
  search.reset();
});

// ---- In code: the query, the results taken, the gates, the people the pages gave ----

const hit = (url: string, title: string, snippet = "") => ({ url, title, snippet });
const PROFILE = (slug: string) => `https://www.linkedin.com/in/${slug}`;

test("the query holds the company's name and the plan's role words of the language, each quoted, and nothing else; at most four words; a word that would pass the port's bound is left out; the plan's words of the query's language come first, else the plan's first language", () => {
  assert.equal(
    managersQuery('Frio "Aurora" Ltda', ["diretor comercial", "gerente de compras"]),
    '"Frio Aurora Ltda" ("diretor comercial" OR "gerente de compras")',
  );
  assert.equal(managersQuery("Frio Aurora", []), '"Frio Aurora"');
  const long = managersQuery("A".repeat(150), ["x".repeat(30), "y".repeat(30), "z".repeat(30)]);
  assert.ok(long.length <= 200, String(long.length));
  const words = roleWordsOf([
    { language: "pt", words: ["a", '"b"', "c", "d", "e", "f"] },
    { language: "de", words: ["Geschäftsführer"] },
    { language: "en", words: [] },
  ]);
  assert.deepEqual(wordsForSearch(words, "de"), ["Geschäftsführer"]);
  assert.deepEqual(wordsForSearch(words, "pt"), ["a", "b", "c", "d"]);
  assert.deepEqual(wordsForSearch(words, "xx"), ["a", "b", "c", "d"]);
  assert.deepEqual(wordsForSearch(words, null), ["a", "b", "c", "d"]);
  assert.deepEqual(roleWordsOf("not words"), []);
  assert.deepEqual(roleWordsOf([]), []);
  assert.equal(wordsForSearch([], "pt"), null);
});

test("a result is taken only when its address is a profile's and its title and snippet name the company, names cleaned as enrichment cleans them; not a company page, a post, a profile's sub-page, another site's address or a result that names another company; one profile once", () => {
  const taken = managerResultsOf(
    [
      hit(PROFILE("a-1"), "Marina Tavares - Diretora - FRÍO  Aurora | LinkedIn", "Curitiba"),
      hit(PROFILE("a-2"), "Paulo Siqueira | LinkedIn", "Gerente de Compras em Frio Aurora"),
      hit(PROFILE("a-3"), "Camila Rocha - Outra Empresa | LinkedIn", "Gerente"),
      hit("https://www.linkedin.com/company/frio-aurora", "Frio Aurora | LinkedIn"),
      hit("https://www.linkedin.com/posts/m_frio-aurora-1", "Marina Tavares, Frio Aurora"),
      hit("https://www.linkedin.com/in/m/details/skills", "Marina Tavares Frio Aurora"),
      hit("https://example.org/in/m", "Marina Tavares Frio Aurora"),
      hit(PROFILE("A-1/"), "Marina Tavares - Diretora - Frio Aurora"),
      hit(PROFILE("a-4"), "Rafael Duarte - Frio Auroras"),
    ],
    "Frío Aurora",
  );
  assert.deepEqual(
    taken.map(({ n, profile }) => [n, profile]),
    [
      [1, "https://linkedin.com/in/a-1"],
      [2, "https://linkedin.com/in/a-2"],
    ],
  );
  assert.deepEqual(managerResultsOf([], "Frio Aurora"), []);
});

const RESULTS = managerResultsOf(
  [
    hit(PROFILE("m-1"), "Marina Tavares - Diretora Comercial - Frio Aurora | LinkedIn", "Curitiba"),
    hit(PROFILE("m-2"), "Paulo Siqueira | LinkedIn", "Gerente de Compras em Frio Aurora"),
    hit(PROFILE("m-3"), "Rafael Duarte - Frio Aurora | LinkedIn", "Curitiba, Brasil"),
  ],
  "Frio Aurora",
);

test("the read's gates keep what the results hold: a result that is not one of them or is answered twice, a name or a role not in that result's title or snippet, a name that holds an @, a person with no role; each is counted by its gate and the rest of the answer kept; the profile is the result's, never the model's", () => {
  const gated = gateManagers(
    {
      people: [
        { result: 1, name: "Marina Tavares", role: "Diretora Comercial" },
        { result: 1, name: "Marina Tavares", role: "Diretora Comercial" },
        { result: 9, name: "Zofia Inventada", role: "Prezes" },
        { result: 2, name: "Paulo Siqueira", role: "Gerente de Compras" },
        { result: 3, name: "Rafael Dua", role: "Diretor" },
        { result: 3, name: "Rafael Duarte", role: "Diretor de Operações" },
        { result: 3, name: "rafael@frio.example", role: "Curitiba" },
      ],
    },
    RESULTS,
  );
  assert.deepEqual(
    gated.people.map(({ name, role, profile, email, country, title }) => [
      ...[name, role, profile, email, country],
      title,
    ]),
    [
      [
        ...["Marina Tavares", "Diretora Comercial", "https://linkedin.com/in/m-1", null, null],
        "Marina Tavares - Diretora Comercial - Frio Aurora | LinkedIn",
      ],
      [
        ...["Paulo Siqueira", "Gerente de Compras", "https://linkedin.com/in/m-2", null, null],
        "Paulo Siqueira | LinkedIn",
      ],
    ],
  );
  assert.deepEqual(gated.refused, { result: 2, name: 2, role: 1 });
});

test("a person on a page and among the results is one lead: by their profile or by their name, accents and case aside; a name twice among the results is the first's", () => {
  const found = gateManagers(
    {
      people: [
        { result: 1, name: "Marina Tavares", role: "Diretora Comercial" },
        { result: 2, name: "Paulo Siqueira", role: "Gerente de Compras" },
      ],
    },
    RESULTS,
  ).people;
  const page = (name: string, profile: string | null = null) => ({ name, profile });
  assert.deepEqual(withoutPagePeople(found, []).length, 2);
  assert.deepEqual(
    withoutPagePeople(found, [page("MARÍNA  tavares")]).map(({ name }) => name),
    ["Paulo Siqueira"],
  );
  assert.deepEqual(
    withoutPagePeople(found, [page("Another Name", "https://linkedin.com/in/m-2")]).map(
      ({ name }) => name,
    ),
    ["Marina Tavares"],
  );
  const twice = [...found, ...found];
  assert.equal(withoutPagePeople(twice, []).length, 2);
});

test("the plan's role words are gated: a language off the bounds is refused, a word that is too long or holds an address, a link or a number is refused and counted, a blank or a repeat is left out, the rest kept; a plan with none keeps none", () => {
  const bounds = {
    places: new Set(["web_search"]),
    countries: new Set(["PL"]),
    languages: new Set(["pl", "de"]),
    kindLanguages: new Set(["pl", "de"]),
    asked: new Set<string>(),
    fits: () => true,
  };
  const gated = gatePlan(
    {
      words: [],
      roleWords: [
        {
          language: "pl",
          words: [
            "dyrektor handlowy",
            " Dyrektor  Handlowy ",
            "",
            "kierownik zakupów",
            "pisz do ana@firma.example",
            "https://firma.example/kadra",
            "tel +48 22 123 45 67",
            "x".repeat(61),
          ],
        },
        { language: "fr", words: ["directeur"] },
        { language: "de", words: ["Geschäftsführer"] },
      ],
      places: [],
      queries: [],
    },
    bounds,
  );
  assert.deepEqual(gated.roleWords, [
    { language: "pl", words: ["dyrektor handlowy", "kierownik zakupów"] },
    { language: "de", words: ["Geschäftsführer"] },
  ]);
  assert.deepEqual(gated.refused, { role_word: 4, language: 1 });
  assert.deepEqual(gatePlan({ words: [], places: [], queries: [] }, bounds).roleWords, []);
});

// ---- The steps ----

const BUSINESSES = {
  frio: {
    domain: "frio-aurora.example" as const,
    name: "Frio Aurora",
    country: "BR",
    language: "pt",
    titles: ["Diretor Comercial", "Gerente de Compras"],
    roleWords: ["diretor comercial", "gerente de compras", "diretora de operações"],
  },
  brandt: {
    domain: "kaffee-brandt.example" as const,
    name: "Kaffee Brandt",
    country: "DE",
    language: "de",
    titles: ["Geschäftsführer", "Leiter Einkauf"],
    roleWords: ["Geschäftsführer", "Leiter Einkauf", "Vertriebsleiter"],
  },
};
type Business = (typeof BUSINESSES)[keyof typeof BUSINESSES];

type Recorded = { messages: { content: { text: string }[] }[] };
const sent = (call: number) => {
  const { messages } = llm.recordedCalls[call]?.input as Recorded;
  return messages.flatMap((message) => message.content.map((part) => part.text)).join("\n");
};
const queryOf = (business: Business) =>
  `"${business.name}" (${business.roleWords.map((word) => `"${word}"`).join(" OR ")})`;

/** A workspace with a research source, the business's audience, and a fit company of the business. */
async function world(tag: string, business: Business, options: { roleWords?: boolean } = {}) {
  const { roleWords = true } = options;
  const workspaceId = `wsp_mgr${tag}`;
  const source = await createSignalSource({
    ...{ workspaceId, label: `Managers ${tag}`, kind: "web_research" },
    config: { focus: "sellers of cold rooms to restaurants", region: business.country },
    senderAccountId: null,
  });
  const { id } = (await tenantOf(workspaceId)(() => readIcpForScoring(workspaceId))).icp;
  await app.icp.update({
    where: { id },
    data: { titles: business.titles, seniorities: ["director", "manager"] },
  });
  const sourceId = source.id;
  const inRun = tenantOf(workspaceId);
  const earlier = await createSignalRun({ workspaceId, sourceId, status: "running" });
  const found = await createFoundCompany({
    ...{ workspaceId, sourceId, domain: business.domain, runId: earlier.id },
    ...{ name: business.name, country: business.country },
    pageUrl: `http://${ADDRESS[business.domain]}:${port}/`,
  });
  /** A run's people as the workflow loops them: its plan with the role words, the queue, then each company. */
  const people = async (plan: boolean | "none" = true) => {
    const run = await createSignalRun({ workspaceId, sourceId, status: "running" });
    if (plan !== "none") {
      await createResearchPlan({
        ...{ workspaceId, sourceId, runId: run.id },
        ...(roleWords
          ? { roleWords: [{ language: business.language, words: business.roleWords }] }
          : {}),
      });
    }
    const ref = { workspaceId, sourceId, runId: run.id };
    const queued = await queuePeople(ref, inRun);
    const steps = [];
    for (let index = 1; index <= (queued.status === "queued" ? queued.companies : 0); index += 1)
      steps.push(await takePeople(ref, index, inRun));
    const counts = async () =>
      ((await app.signalRun.findFirstOrThrow({ where: { id: run.id } })).counts ?? {}) as Record<
        string,
        number
      >;
    return { ref, steps, counts };
  };
  const leads = () => app.person.findMany({ where: { workspaceId }, orderBy: { id: "asc" } });
  return { workspaceId, sourceId, inRun, found, people, leads };
}
const nameOf = (person: { firstName: string | null; lastName: string | null }) =>
  [person.firstName, person.lastName].join(" ");

const NOBODY = { people: [] };
const person = (result: number, name: string, role: string) => ({ result, name, role });

test("a Brazilian company whose pages name nobody gets one search for its managers, limited to linkedin.com, with its country, its name and the plan's role words the only words; the results that are a profile's and name the company go to the model with no address, the people it reads are gated, the pick judges their roles alone and the two picked become leads with their profiles, the company's country, an email lookup each and evidence that says managers, with the result's title and the company's site; nothing is fetched from LinkedIn", async () => {
  const business = BUSINESSES.frio;
  const kestrel = await world("br", business);
  search.seedResults(queryOf(business), [
    hit(
      PROFILE("marina-tavares-fa"),
      "Marina Tavares - Diretora Comercial - Frio Aurora | LinkedIn",
      "Curitiba, Brasil. Diretora Comercial na Frio Aurora.",
    ),
    hit(
      PROFILE("paulo-siqueira-fa"),
      "Paulo Siqueira - Gerente de Compras - Frio Aurora | LinkedIn",
      "Gerente de Compras na Frio Aurora.",
    ),
    hit(
      PROFILE("camila-rocha-fa"),
      "Camila Rocha - Estagiária de Marketing - Frio Aurora | LinkedIn",
      "Estagiária de Marketing na Frio Aurora.",
    ),
    hit(PROFILE("rafael-duarte-fa"), "Rafael Duarte | LinkedIn", "Frio Aurora, Curitiba."),
    hit(
      PROFILE("sofia-lima-xx"),
      "Sofia Lima - Diretora Comercial - Outra Empresa | LinkedIn",
      "Outra Empresa.",
    ),
    hit(
      "https://www.linkedin.com/company/frio-aurora",
      "Frio Aurora | LinkedIn",
      "Câmaras frigoríficas.",
    ),
    hit(
      "https://www.linkedin.com/posts/marina-tavares_frio-aurora-activity-1",
      "Marina Tavares na Frio Aurora",
    ),
  ]);
  llm.script(
    NOBODY,
    {
      people: [
        person(1, "Marina Tavares", "Diretora Comercial"),
        person(2, "Paulo Siqueira", "Gerente de Compras"),
        person(3, "Camila Rocha", "Estagiária de Marketing"),
        person(4, "Rafael Duarte", "Diretor de Operações"),
      ],
    },
    { picks: [{ index: 1 }, { index: 2 }] },
  );
  const requested: string[] = [];
  const original = globalThis.fetch;
  mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requested.push(String(input instanceof Request ? input.url : input));
    return original(input, init);
  });
  useWebSearchAdapters(["fake"]);
  let run: Awaited<ReturnType<typeof kestrel.people>>;
  try {
    run = await kestrel.people();
  } finally {
    useWebSearchAdapters(undefined);
    mock.restoreAll();
  }
  assert.deepEqual(run.steps, [{ status: "taken", found: 2 }]);
  // One search: the company's name and the role words, on linkedin.com, in Brazil, 10 results.
  const calls = search.recordedCalls.map(({ input }) => input as Record<string, unknown>);
  assert.deepEqual(
    calls.map(({ query, site, country, count, language, page }) => [
      query,
      site,
      country,
      count,
      language,
      page,
    ]),
    [[queryOf(business), "linkedin.com", "BR", 10, undefined, undefined]],
  );
  assert.deepEqual(
    requested.filter((address) => /linkedin\./i.test(address)),
    [],
    "no request went to linkedin.com",
  );
  // The leads: the picked people, with the result's profile and the company's country.
  const persons = await kestrel.leads();
  assert.deepEqual(
    persons.map((row) => [nameOf(row), row.title, row.linkedinUrl, row.locationCountry]).sort(),
    [
      ["Marina Tavares", "Diretora Comercial", "https://linkedin.com/in/marina-tavares-fa", "BR"],
      ["Paulo Siqueira", "Gerente de Compras", "https://linkedin.com/in/paulo-siqueira-fa", "BR"],
    ],
  );
  assert.deepEqual(await run.counts(), {
    ...{ people_companies: 1, people_picked: 2, people_found: 2, people_lookups: 2 },
    ...{ searches_asked: 1, managers_searches: 1, managers_results: 4, managers_people: 3 },
    managers_refused_role: 1,
  });
  // One email lookup for each new lead, as for any lead the people step makes.
  assert.equal(
    await app.enrichmentRequest.count({ where: { workspaceId: kestrel.workspaceId } }),
    2,
  );
  // The evidence: found by the managers' search, the result's title, the company's site as the link.
  const evidence = await app.evidence.findMany({ where: { workspaceId: kestrel.workspaceId } });
  assert.deepEqual(
    evidence.map((row) => [row.foundBy, row.url, row.excerpt, row.author, row.reaction]).sort(),
    [
      [
        "managers",
        "https://frio-aurora.example/",
        "Marina Tavares - Diretora Comercial - Frio Aurora | LinkedIn",
        null,
        null,
      ],
      [
        "managers",
        "https://frio-aurora.example/",
        "Paulo Siqueira - Gerente de Compras - Frio Aurora | LinkedIn",
        null,
        null,
      ],
    ],
  );
  const events = await app.signalEvent.findMany({ where: { workspaceId: kestrel.workspaceId } });
  assert.deepEqual(
    events.map((event) => [event.kind, event.foundCompanyId, event.ratingStatus]),
    [
      ["web_research", kestrel.found.id, "unrated"],
      ["web_research", kestrel.found.id, "unrated"],
    ],
  );
  // The run's counts and files hold no name; the results are the run's file, kept for the next attempt.
  const row = await app.signalRun.findFirstOrThrow({ where: { id: run.ref.runId } });
  for (const name of ["Marina", "Paulo", "Camila", "Rafael", "Tavares", "linkedin"])
    assert.ok(!JSON.stringify(row.counts).includes(name), name);
  const filed = await readJsonFile(
    kestrel.workspaceId,
    managersKey(run.ref.runId, kestrel.found.id),
  );
  assert.equal((filed as { results: unknown[] }).results.length, 7);
  // The model read titles and snippets of the four results code took, with no address and no company
  // page, post or other company's result; the pick saw roles only.
  const read = sent(1);
  assert.ok(read.includes("<company>") && read.includes("<results>"));
  assert.ok(read.includes("Marina Tavares - Diretora Comercial - Frio Aurora"));
  for (const absent of ["linkedin.com", "/in/", "Sofia Lima", "Outra Empresa", "activity-1"])
    assert.ok(!read.includes(absent), absent);
  const pick = sent(2);
  assert.ok(pick.includes("<audience>") && pick.includes("<people>"));
  for (const role of ["Diretora Comercial", "Gerente de Compras", "Estagiária de Marketing"])
    assert.ok(pick.includes(role), role);
  for (const hidden of [
    "Marina",
    "Tavares",
    "Paulo",
    "Siqueira",
    "Camila",
    "Rocha",
    "Rafael",
    "Duarte",
    "linkedin",
  ])
    assert.ok(!pick.includes(hidden), hidden);
  assert.equal(llm.recordedCalls.length, 3);
});

test("a German company whose pages name nobody: the search is in the company's country with the plan's German role words, and the people picked from the results are leads with the company's country", async () => {
  const business = BUSINESSES.brandt;
  const brandt = await world("de", business);
  search.seedResults(queryOf(business), [
    hit(
      PROFILE("jonas-weber-kb"),
      "Jonas Weber - Geschäftsführer - Kaffee Brandt | LinkedIn",
      "Hamburg. Geschäftsführer bei Kaffee Brandt.",
    ),
    hit(
      PROFILE("anna-schmidt-kb"),
      "Anna Schmidt - Leiterin Einkauf - Kaffee Brandt | LinkedIn",
      "Leiterin Einkauf bei Kaffee Brandt.",
    ),
  ]);
  llm.script(
    NOBODY,
    {
      people: [
        person(1, "Jonas Weber", "Geschäftsführer"),
        person(2, "Anna Schmidt", "Leiterin Einkauf"),
      ],
    },
    { picks: [{ index: 2 }, { index: 1 }] },
  );
  useWebSearchAdapters(["fake"]);
  try {
    const run = await brandt.people();
    assert.deepEqual(run.steps, [{ status: "taken", found: 2 }]);
    const calls = search.recordedCalls.map(({ input }) => input as Record<string, unknown>);
    assert.deepEqual(
      calls.map(({ query, country }) => [query, country]),
      [[queryOf(business), "DE"]],
    );
    assert.deepEqual(
      (await brandt.leads())
        .map((row) => [nameOf(row), row.linkedinUrl, row.locationCountry])
        .sort(),
      [
        ["Anna Schmidt", "https://linkedin.com/in/anna-schmidt-kb", "DE"],
        ["Jonas Weber", "https://linkedin.com/in/jonas-weber-kb", "DE"],
      ],
    );
  } finally {
    useWebSearchAdapters(undefined);
  }
});

test("a person on a page and among the results is one lead: the page's keeps the page's key and evidence, the managers' search adds the one the pages did not name, and the pick for the results sees only the places left", async () => {
  const business = BUSINESSES.frio;
  const kestrel = await world("both", business);
  search.seedResults(queryOf(business), [
    hit(
      PROFILE("marina-tavares-fa"),
      "Marina Tavares - Diretora Comercial - Frio Aurora | LinkedIn",
    ),
    hit(
      PROFILE("paulo-siqueira-fa"),
      "Paulo Siqueira - Gerente de Compras - Frio Aurora | LinkedIn",
    ),
  ]);
  llm.script(
    {
      people: [
        {
          ...{ page: 2, name: "Marina Tavares", role: "Diretora Comercial" },
          ...{
            profile: null,
            email: "marina.tavares@frio-aurora.example",
            phone: null,
            place: null,
          },
        },
      ],
    },
    { picks: [{ index: 1 }] },
    {
      people: [
        person(1, "Marina Tavares", "Diretora Comercial"),
        person(2, "Paulo Siqueira", "Gerente de Compras"),
      ],
    },
    { picks: [{ index: 1 }] },
  );
  useWebSearchAdapters(["fake"]);
  try {
    const run = await kestrel.people();
    assert.deepEqual(run.steps, [{ status: "taken", found: 2 }]);
    const persons = await kestrel.leads();
    assert.deepEqual(persons.map((row) => [nameOf(row), row.linkedinUrl]).sort(), [
      ["Marina Tavares", null],
      ["Paulo Siqueira", "https://linkedin.com/in/paulo-siqueira-fa"],
    ]);
    assert.equal(await app.lead.count({ where: { workspaceId: kestrel.workspaceId } }), 2);
    const evidence = await app.evidence.findMany({ where: { workspaceId: kestrel.workspaceId } });
    assert.deepEqual(evidence.map((row) => [row.foundBy, row.excerpt === null]).sort(), [
      [null, true],
      ["managers", false],
    ]);
    // The pick for the results saw one role, the one person the pages did not name.
    assert.ok(sent(3).includes("Gerente de Compras") && !sent(3).includes("Diretora Comercial"));
  } finally {
    useWebSearchAdapters(undefined);
  }
});

test("a company whose pages gave the limit already gets no search: four people picked from its pages, SIGNALS_RESEARCH_PEOPLE_PER_COMPANY being 4, no search asked and no result read", async () => {
  const business = BUSINESSES.brandt;
  const brandt = await world("limit", business);
  const team = (name: string, role: string, email: string) => ({
    ...{ page: 2, name, role },
    ...{ profile: null, email, phone: null, place: null },
  });
  llm.script(
    {
      people: [
        team("Jonas Weber", "Geschäftsführer", "jonas.weber@kaffee-brandt.example"),
        team("Anna Schmidt", "Leiterin Einkauf", "anna.schmidt@kaffee-brandt.example"),
        team("Lena Vogt", "Vertriebsleiterin", "lena.vogt@kaffee-brandt.example"),
        team("Mia Keller", "Einkaufsleiterin", "mia.keller@kaffee-brandt.example"),
      ],
    },
    { picks: [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }] },
  );
  useWebSearchAdapters(["fake"]);
  try {
    const run = await brandt.people();
    assert.deepEqual(run.steps, [{ status: "taken", found: 4 }]);
    assert.equal(search.recordedCalls.length, 0);
    assert.equal(llm.recordedCalls.length, 2);
    const counts = await run.counts();
    assert.deepEqual(
      [counts.searches_asked, counts.managers_searches, counts.managers_people],
      [undefined, undefined, undefined],
    );
  } finally {
    useWebSearchAdapters(undefined);
  }
});

test("no search is asked for a plan with no role words, for a run with no plan, with the run's searches at their limit (budget_reached is set once), or with every adapter spent or none loaded; the people the pages named are made as before", async () => {
  const business = BUSINESSES.frio;
  const pageOnly = () => {
    llm.reset();
    llm.script(
      {
        people: [
          {
            ...{ page: 2, name: "Marina Tavares", role: "Diretora Comercial" },
            ...{
              profile: null,
              email: "marina.tavares@frio-aurora.example",
              phone: null,
              place: null,
            },
          },
        ],
      },
      { picks: [{ index: 1 }] },
    );
  };
  useWebSearchAdapters(["fake"]);
  try {
    const old = await world("noroles", business, { roleWords: false });
    pageOnly();
    assert.deepEqual((await old.people()).steps, [{ status: "taken", found: 1 }]);
    const none = await world("noplan", business);
    pageOnly();
    assert.deepEqual((await none.people("none")).steps, [{ status: "taken", found: 1 }]);
    assert.equal(search.recordedCalls.length, 0);
    // The run's searches at their limit (3 here): no search, budget_reached set once.
    const limited = await world("limit3", business);
    pageOnly();
    const budget = await createSignalRun({
      ...{ workspaceId: limited.workspaceId, sourceId: limited.sourceId, status: "running" },
      counts: { searches_asked: 3 },
    });
    await createResearchPlan({
      ...{ workspaceId: limited.workspaceId, sourceId: limited.sourceId, runId: budget.id },
      roleWords: [{ language: "pt", words: business.roleWords }],
    });
    const ref = { workspaceId: limited.workspaceId, sourceId: limited.sourceId, runId: budget.id };
    await queuePeople(ref, limited.inRun);
    assert.deepEqual(await takePeople(ref, 1, limited.inRun), { status: "taken", found: 1 });
    assert.equal(search.recordedCalls.length, 0);
    const row = await app.signalRun.findFirstOrThrow({ where: { id: budget.id } });
    assert.equal((row.counts as Record<string, number>).budget_reached, 1);
    // Every adapter spent, and none loaded.
    const spent = await world("spent", business);
    pageOnly();
    search.failNext("web_search_provider_error");
    assert.deepEqual((await spent.people()).steps, [{ status: "taken", found: 1 }]);
    assert.equal(search.recordedCalls.length, 1);
  } finally {
    useWebSearchAdapters(undefined);
  }
  const closed = await world("noadapter", business);
  llm.reset();
  llm.script({ people: [] });
  assert.deepEqual((await closed.people()).steps, [{ status: "taken", found: 0 }]);
  assert.equal(search.recordedCalls.length, 1);
});

test("a read the model fails twice leaves the company to the next attempt, which reads the kept results and asks no second search; a search that gives nothing worth reading ends the look with no model asked", async () => {
  const business = BUSINESSES.frio;
  const kestrel = await world("retry", business);
  search.seedResults(queryOf(business), [
    hit(
      PROFILE("marina-tavares-fa"),
      "Marina Tavares - Diretora Comercial - Frio Aurora | LinkedIn",
    ),
  ]);
  llm.script(NOBODY, { nope: 1 }, { nope: 1 });
  useWebSearchAdapters(["fake"]);
  try {
    const run = await kestrel.people();
    assert.deepEqual(run.steps, [{ status: "failed" }]);
    assert.equal(search.recordedCalls.length, 1);
    assert.equal((await run.counts()).managers_reads_failed, 1);
    assert.equal(
      (await app.signalFoundCompany.findFirstOrThrow({ where: { id: kestrel.found.id } }))
        .peopleTakenAt,
      null,
    );
    // The step run again on the same run: the kept results, no second search, and the pages' read, an
    // answer the model already gave for the same input, is not asked again.
    llm.reset();
    llm.script(
      { people: [person(1, "Marina Tavares", "Diretora Comercial")] },
      { picks: [{ index: 1 }] },
    );
    const again = await takePeople(run.ref, 1, kestrel.inRun);
    assert.deepEqual(again, { status: "taken", found: 1 });
    assert.equal(search.recordedCalls.length, 1);
    assert.equal(await app.person.count({ where: { workspaceId: kestrel.workspaceId } }), 1);
  } finally {
    useWebSearchAdapters(undefined);
  }
  // Results of other companies and pages only: nothing is read.
  const other = await world("empty", business);
  search.seedResults(queryOf(business), [
    hit("https://www.linkedin.com/company/frio-aurora", "Frio Aurora | LinkedIn"),
    hit(PROFILE("x-1"), "Someone - Outra Empresa | LinkedIn"),
  ]);
  llm.reset();
  llm.script(NOBODY);
  useWebSearchAdapters(["fake"]);
  try {
    const run = await other.people();
    assert.deepEqual(run.steps, [{ status: "taken", found: 0 }]);
    assert.equal(llm.recordedCalls.length, 1);
    assert.equal((await run.counts()).managers_results ?? 0, 0);
  } finally {
    useWebSearchAdapters(undefined);
  }
});

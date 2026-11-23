// A research source's run end to end (gamma-wr-030; core/modules/signals/README.md "Runs"), on the
// slice's Temporal and a schema of its database: credits, linkedin and signals loaded from their
// builds by the worker's own loader, their activities through the host's wrapper on one worker of
// the test's queue, on the LinkedIn and files fakes. In a workspace with no LinkedIn account a member
// creates a research source, links it to their agent, and Run now ends the run `done` with empty
// counts, no call having reached the LinkedIn fake; an audience with no country ends it `failed`,
// `research_no_country`; a paused agent's run ends `cancelled` at its start; a stop asked before its
// first step ends its row `cancelled`; the daily tick writes a run for the sources due and none for
// the others, and the run it wrote ends done. The history carries ids, a count and a code, never the
// source's words; the first run's is workflows/__histories__/signals_research_run.json
// (history:record).
// gamma-wr-040: the run plans after its start, on the LLM fake: its plan and its queries are kept, the
// counts say how many, and the history holds neither a word nor a query; a plan the model fails twice
// ends the run `failed`, `research_plan_failed`; the run of before the patch, recorded in
// signals_research_run.json, replays, and so does the planned one, signals_research_run_plan.json.
// gamma-wr-041: the run then searches the plan's queries, one a step, on the web-search fake behind
// enrichment's counted search and the files fake: each with its country and language, its answer kept
// under raw/signals/<runId>/search/, its query marked asked; a second run asks none of the first
// run's; SIGNALS_RESEARCH_SEARCHES_PER_RUN (3 here) ends a run `done` with counts.budget_reached, every
// adapter spent ends it `done` with counts.adapters_spent, and no adapter loaded ends it `failed`,
// `research_search_unavailable`; the history holds ids, counts and codes, never a query; the run
// recorded in signals_research_run_search.json replays with the others.
// gamma-wr-045: the run then picks, for each search, the results worth reading (the LLM fake), lines the
// pages up and reads them on local pages (a server on 127.0.0.2 to 127.0.0.4, the web search's https
// addresses served there by signals' useReadPage): the start page first, then the picks; a page its
// robots.txt closes and a result on LinkedIn are never requested; a PDF file is read as text; at
// SIGNALS_RESEARCH_PAGES_PER_RUN (4 here) the run ends `done` with counts.budget_reached; each page is
// a file under raw/signals/<runId>/pages/; the history holds ids, counts and codes, never a link or a
// page's text; the run recorded in signals_research_run_pages.json replays with the others.
// gamma-wr-046: the run then says what each page read is and which companies it names (the LLM fake),
// makes their candidates (a company named without a link searched by its name on the search fake,
// inside the searches' limit) and checks the candidates its earlier runs left against the never-contact
// list: a company's own site, the two companies of a list page and the company of an award notice in a
// PDF file become candidates with their page, source type and quote; a second run drops the one now on
// the never-contact list, counts the rest carried and makes none again; the history holds ids, counts
// and codes, never a company's name, a link or a quote; the run recorded in
// signals_research_run_candidates.json replays with the others.
// gamma-wr-050: the run then reads each candidate's site (a local server, enrichment's site reader
// pointed there), has the judge answer on the LLM fake, decides the verdict in code and keeps the found
// company, its company in contacts and its reasons: a site that shows the focus is fit; the counts say
// how many; a second run judges none of the first run's; the history holds ids, counts and codes, never a company's name, a
// quote or an address; the run recorded in signals_research_run_judge.json replays with the others.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";

// The local pages of the research run's reading: hosts of 127.0.0.0/8 the egress client reaches through
// EGRESS_ALLOW_HOSTS, set before the platform loads, one server answering by the Host header.
const ADDRESS = {
  "nord.example": "127.0.0.2",
  "fair.example": "127.0.0.3",
  "closed.example": "127.0.0.4",
};
const served: string[] = [];
const HTML = { "content-type": "text/html; charset=utf-8" };
// The people a company's page names (gamma-wr-060): made-up, so that a history, a log line and a file
// can be searched for them.
const TEAM =
  "Karla Nordmann, Head of Sales, karla.nordmann@nord.example, direct line +49 30 5550 1234. Hans Nordstern, Office Assistant. Ilse Nordhaus, Head of Purchasing.";
const prose = (name: string, more = "") =>
  `<!doctype html><html><head><title>${name}</title></head><body><main><p>${name}. ${"A made-up company that sells and services refrigerated vehicles for food traders. ".repeat(3)}${more}</p></main></body></html>`;
const NOTICE = "Award notice: the contract goes to Quillon Mills of Brno";
const EXHIBITORS = `<!doctype html><html><head><title>Exhibitors</title></head><body><main><h1>Exhibitors of the cold chain fair</h1><p>Brno Cold Storage s.r.o., Brno: cold storage and distribution of chilled food. <a href="https://brno-cold.example/">site</a></p><p>Moravia Reefer Trans, Ostrava: refrigerated road transport across the region. <a href="https://moravia-reefer.example/">site</a></p><p>${"The fair runs for three days every spring in the exhibition hall. ".repeat(3)}</p></main></body></html>`;
const localServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const ip = (req.headers.host ?? "").split(":")[0];
  const site = Object.entries(ADDRESS).find(([, address]) => address === ip)?.[0] ?? "";
  const path = (req.url ?? "").split("?")[0] ?? "";
  served.push(`${site}${path}`);
  if (path === "/robots.txt") {
    const closed = site === "closed.example";
    res
      .writeHead(closed ? 200 : 404, { "content-type": "text/plain" })
      .end(closed ? "User-agent: *\nDisallow: /private\n" : "");
  } else if (path === "/files/award.pdf") {
    res.writeHead(200, { "content-type": "application/pdf" }).end(signals.textPdf([NOTICE]));
  } else if (path === "/list" && site === "fair.example") {
    res.writeHead(200, HTML).end(EXHIBITORS);
  } else if (path === "/" && site === "nord.example") {
    res.writeHead(200, HTML).end(prose("Nord Cold Chain Ltd", TEAM));
  } else if (path === "/private/list" || /^\/(about|team|exhibitors)?$/.test(path)) {
    res.writeHead(200, HTML).end(prose(`${site}${path}`));
  } else res.writeHead(404).end("not found");
});
await new Promise<void>((resolve) => localServer.listen(0, "0.0.0.0", resolve));
const localPort = (localServer.address() as AddressInfo).port;
process.env.EGRESS_ALLOW_HOSTS = Object.values(ADDRESS)
  .map((ip) => `${ip}:${localPort}`)
  .join(",");
after(() => {
  localServer.closeAllConnections();
  localServer.close();
});

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.PROVIDER_LLM = "fake";
process.env.PROVIDER_EMAIL_FINDER = "fake";
process.env.PROVIDER_EMAIL_VERIFIER = "fake";
process.env.SIGNALS_RESEARCH_SEARCHES_PER_RUN = "3";
process.env.SIGNALS_RESEARCH_PAGES_PER_RUN = "4";

const { loadAgentTasks } = await import("@whytide/ai");
const { NativeConnection, Worker } = await import("@temporalio/worker");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { filesPort, getAdapter, linkedinPort, llmPort, webSearchPort } = await import(
  "@whytide/providers"
);
const { assemblePrices, grantAllowance, syncPrices, useCreditsClient } = await import(
  "@whytide/credits/testing"
);
const { hostActivity } = await import("../src/activities.ts");
const { workerConfig } = await import("../src/config.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { IDENTITY, metricSinks, workflowBundle } = await import("../src/temporal.ts");
const { replayHistories, withTestWorkflowEnvironment } = await import("../testing/index.ts");

// The modules' commands and test hooks by their builds' paths, the files the worker's loader imports.
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
const builtPath = (path: string) => new URL(`../../../modules/${path}`, import.meta.url);
type ContactsTesting = typeof import("../../../modules/contacts/dist/testing/index.js");
type IcpCommands = typeof import("../../../modules/icp/dist/domain/commands.js");
type EnrichmentTesting = typeof import("../../../modules/enrichment/dist/testing/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type PlaybooksDomain = typeof import("../../../modules/playbooks/dist/domain/playbooks.js");
type PlaybooksTesting = typeof import("../../../modules/playbooks/dist/testing/index.js");
type FoundList = typeof import("../../../modules/signals/dist/domain/research/found-list.js");
type Sources = typeof import("../../../modules/signals/dist/domain/sources.js");
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const contacts: ContactsTesting = await built("contacts/dist/testing/index.js");
const icp: IcpCommands = await built("icp/dist/domain/commands.js");
const enrichment: EnrichmentTesting = await built("enrichment/dist/testing/index.js");
const linkedin: LinkedinTesting = await built("linkedin/dist/testing/index.js");
const { updatePlaybook }: PlaybooksDomain = await built("playbooks/dist/domain/playbooks.js");
const playbooks: PlaybooksTesting = await built("playbooks/dist/testing/index.js");
const { createSource, requestRun, stopRun }: Sources = await built(
  "signals/dist/domain/sources.js",
);
const { markNotFit }: FoundList = await built("signals/dist/domain/research/found-list.js");
const signals: SignalsTesting = await built("signals/dist/testing/index.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");
type LinkedinFake = import("@whytide/providers").LinkedinFake;
type LlmFake = import("@whytide/providers").LlmFake;
type SearchFake = import("@whytide/providers").WebSearchFake;
type FilesFake = {
  reset(): void;
  list(input: { workspaceId: string; prefix: string }): Promise<{ files: { key: string }[] }>;
};
type Tenant = Awaited<ReturnType<TenancyTesting["createTwoWorkspaces"]>>[number];
type TenantClient = import("@whytide/db").TenantClient;
type Activity = (input: never) => Promise<unknown>;
type RunResult = { runId: string; status: string; code?: string };
type Tick = { workspaces: number; started: number };

withTestDb();
const env = withTestWorkflowEnvironment();
const db = () => asRole("app");
useCreditsClient(db());
enrichment.useEnrichmentClient(db());
enrichment.useWebSearchAdapters(["fake"]);
linkedin.useLinkedinClient(db());
tenancy.useTenancyClient(db());
signals.useSignalsClient(db());
// The web search answers https addresses; the reader serves a known host from the local server, and
// any other host is refused as the egress client refuses a private one, so that no test reaches the
// network.
signals.useReadPage((url, options) => {
  const ip = ADDRESS[url.hostname as keyof typeof ADDRESS];
  if (ip === undefined) return Promise.resolve({ ok: false, code: "egress_blocked_address" });
  const plain = new URL(url);
  plain.protocol = "http:";
  plain.hostname = ip;
  plain.port = String(localPort);
  // The page as the search named it: its address is the https one, as a real page's final address is.
  return platform
    .readPage(plain, options)
    .then((read) => (read.ok ? { ok: true, page: { ...read.page, url: url.href } } : read));
});
// A company's own site: its home is on the local server for the test that judges, and its real
// address, refused by the egress client, for the others.
let sitesLocal = false;
enrichment.useSiteHome((domain) => {
  const ip = ADDRESS[domain as keyof typeof ADDRESS];
  return !sitesLocal || ip === undefined
    ? new URL(`https://${domain}/`)
    : new URL(`http://${ip}:${localPort}/`);
});
playbooks.usePlaybooksClient(db());
contacts.useHashSalt("test-salt-".repeat(4));
linkedin.useSecretKeys(platform.loadMasterKeys({ APP_MASTER_KEY: platform.newMasterKey() }));
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
await loadAgentTasks();
const names = new Set(["credits", "linkedin", "signals"]);
const loaded = await loadModules(moduleLoaders.filter(({ name }) => names.has(name)));
await startModules(loaded, log);
const activities: Record<string, Activity> = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: db(), log })];
  }),
);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const llm = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const search = (await getAdapter(webSearchPort, "fake")) as unknown as SearchFake;
const files = (await getAdapter(filesPort, "fake")) as unknown as FilesFake;
beforeEach(() => {
  search.reset();
  files.reset();
  llm.reset();
  served.length = 0;
  sitesLocal = false;
  signals.forgetReads();
  enrichment.useWebSearchAdapters(["fake"]);
});
const HISTORIES = [
  "signals_research_run",
  "signals_research_run_plan",
  "signals_research_run_search",
  "signals_research_run_pages",
  "signals_research_run_candidates",
  "signals_research_run_judge",
  "signals_research_run_credits",
  "signals_research_run_people",
  "signals_research_run_managers",
].map((name) => fileURLToPath(builtPath(`signals/workflows/__histories__/${name}.json`)));
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal: platform.servicePrincipal("test") }, fn, { client: db() });
const DAY_MS = 86_400_000;
const WORDS = "traders of grain";
/** What the LLM fake plans: made-up words and queries, so that the history can be searched for them. */
const PLAN_WORD = "kornspeicher-alpha";
const PLAN_QUERY = "grain silo operators northern plain zeta";
const PLAN_QUERIES = [PLAN_QUERY, "grain traders association members"];
/** The fake's next answer: a plan with `count` queries in `country`, in English. */
const scriptPlan = (country = "DE", count = 2) =>
  llm.script({
    words: [{ language: "en", words: [PLAN_WORD, "grain elevator"] }],
    places: ["web_search", "association_members"],
    queries: Array.from({ length: count }, (_, at) => ({
      place: at % 2 === 0 ? "web_search" : "association_members",
      country,
      language: "en",
      text: PLAN_QUERIES[at] ?? `${PLAN_QUERY} number ${at}`,
    })),
  });
/** The pick's next answers: `count` picks of no result, for searches whose results nothing is worth reading in. */
const scriptNoPicks = (count: number) =>
  llm.script(...Array.from({ length: count }, () => ({ picks: [] })));
/** The results the search fake answers each query of the plan with. */
const seedSearch = (count = 2) => {
  for (let at = 0; at < count; at += 1) {
    const text = PLAN_QUERIES[at] ?? `${PLAN_QUERY} number ${at}`;
    const results = [1, 2, 3].map((n) => ({
      url: `https://silo-${at}-${n}.example/`,
      title: `Silo ${n}`,
      snippet: "",
    }));
    search.seedResults(text, results);
  }
};
const searched = () => search.recordedCalls.map(({ input }) => input as Record<string, unknown>);

/** The first step held until `release()`, for the test that asks a stop while it runs. */
let held: { arrive: () => void; gate: Promise<void> } | undefined;
const signals_research_start = async (input: never) => {
  const hold = held;
  held = undefined;
  if (hold !== undefined) {
    hold.arrive();
    await hold.gate;
  }
  return activities.signals_research_start?.(input);
};

let connection: import("@temporalio/worker").NativeConnection | undefined;
let worker: import("@temporalio/worker").Worker | undefined;
let running: Promise<void> | undefined;
before(async () => {
  connection = await NativeConnection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  worker = await Worker.create({
    connection,
    namespace: env.namespace,
    taskQueue: env.taskQueue,
    identity: IDENTITY,
    workflowBundle: await workflowBundle(env.workflowsPath),
    activities: { ...activities, signals_research_start },
    sinks: metricSinks(),
  });
  running = worker.run();
});
after(async () => {
  worker?.shutdown();
  await running;
  await connection?.close();
});

/** A workflow started on the test's worker, under `workflowId` when given. */
const start = (workflow: string, input: object, workflowId?: string) =>
  env.client.workflow.start(workflow, {
    args: [input],
    taskQueue: env.taskQueue,
    workflowId: workflowId ?? `${workflow}-${randomUUID()}`,
    workflowExecutionTimeout: "1 minute",
  });
const execute = async <T>(workflow: string, input: object, workflowId?: string): Promise<T> =>
  (await start(workflow, input, workflowId)).result() as Promise<T>;
/** The research run of a row Run now or the tick wrote. */
const researchRun = (workspaceId: string, sourceId: string, runId: string, id?: string) =>
  execute<RunResult>("signals_research_run", { workspaceId, sourceId, runId }, id);

/**
 * A workspace with no LinkedIn account, its default audience in these countries, and `allowance` credits
 * under the price list the modules declare, as the api's start writes it (each test starts truncated).
 */
async function workspaceIn(countries: string[], allowance = 1000) {
  const declared = [...platform.registeredPrices().values()];
  await syncPrices(asRole("billing_writer"), assemblePrices(declared, {}), log);
  const [tenant] = await tenancy.createTwoWorkspaces();
  await grantAllowance([(tenant as Tenant).organization.id], allowance);
  const workspaceId = (tenant as Tenant).workspace.id;
  await inRun(workspaceId, async (tx) => {
    const { id } = (await icp.readIcpForScoring(workspaceId)).icp;
    await tx.icp.update({ where: { id }, data: { countries } });
  });
  return { tenant: tenant as Tenant, workspaceId };
}

/**
 * A research source made by the tenant's user as the route makes one, held by an agent of its own
 * audience, in `countries`, unless `agent` is false.
 */
async function researchOf(
  tenant: Tenant,
  label: string,
  options: {
    agent?: boolean;
    countries?: string[];
    focus?: string;
    startPages?: string[];
    titles?: string[];
  } = {},
) {
  const { agent = true, countries = ["DE"], focus = WORDS, startPages, titles = [] } = options;
  const workspaceId = tenant.workspace.id;
  const config = { focus, languages: ["en"], ...(startPages && { startPages }) };
  const input = { kind: "web_research", config, label };
  const source = await inRun(workspaceId, () => createSource(input));
  if (!agent) return { workspaceId, sourceId: source.id };
  const createdBy = tenant.user.id;
  const audience = await inRun(workspaceId, () => icp.createAudience({ name: label, createdBy }));
  await inRun(workspaceId, (tx) =>
    tx.icp.update({ where: { id: audience.id }, data: { countries, titles } }),
  );
  const created = { workspaceId, icpId: audience.id, ownerUserId: "usr_test", name: label };
  const playbookId = await playbooks.createPlaybook({ ...created, sourceIds: [source.id] });
  return { workspaceId, sourceId: source.id, playbookId };
}
const rowOf = (runId: string) => db().signalRun.findUniqueOrThrow({ where: { id: runId } });
/** The payloads of the workflow's history, decoded. */
async function historyOf(workflowId: string): Promise<string> {
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  const decoded: string[] = [];
  JSON.stringify(JSON.parse(historyToJSON(history)), (_key, value) => {
    const { data, metadata } = (value ?? {}) as { data?: unknown; metadata?: unknown };
    if (typeof data === "string" && metadata) decoded.push(Buffer.from(data, "base64").toString());
    return value;
  });
  return decoded.join("\n");
}

test("with no LinkedIn account in the workspace, a member creates a research source, links it to their agent and Run now plans the run on the LLM fake, searches its queries on the search fake with their country and language and ends done with the plan's and the search's counts, no call having reached the LinkedIn fake and no sender account row read or made; its plan and its queries are kept, each answer is a file under the run's search folder and each query is marked asked, its history holds ids and counts, not its words, its plan's words, its queries or its results", async (t) => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  assert.equal(await db().senderAccount.count({ where: { workspaceId } }), 0);
  const calls = fake.recordedCalls.length;
  const { sourceId } = await researchOf(tenant, "Grain");
  scriptPlan();
  scriptNoPicks(2);
  seedSearch();
  const requested = await inRun(workspaceId, () => requestRun(sourceId));
  assert.equal(requested.status, "scheduled");
  const workflowId = `signals_research_run_search-${randomUUID()}`;
  // The run whose history is workflows/__histories__/signals_research_run_search.json (history:record).
  t.diagnostic(`signals_research_run ran as ${workflowId}`);
  const done = await researchRun(workspaceId, sourceId, requested.id, workflowId);
  assert.deepEqual(done, { runId: requested.id, status: "done" });
  const row = await rowOf(requested.id);
  assert.deepEqual(
    [row.status, row.counts, row.error, row.workflowId, row.quotaDay, row.readBudget],
    [
      "done",
      { queries_planned: 2, searches_asked: 2, search_results: 6 },
      null,
      workflowId,
      null,
      null,
    ],
  );
  assert.ok(row.startedAt !== null && row.finishedAt !== null);
  const source = await db().signalSource.findUniqueOrThrow({ where: { id: sourceId } });
  assert.deepEqual(
    [source.lastRunAt?.getTime(), source.watermark],
    [row.startedAt.getTime(), null],
  );
  assert.equal(fake.recordedCalls.length, calls, "a call reached the LinkedIn fake");
  assert.equal(await db().senderQuotaReservation.count(), 0);
  const plan = await db().signalResearchPlan.findFirstOrThrow({ where: { runId: requested.id } });
  assert.deepEqual(plan.placeIds, ["web_search", "association_members"]);
  assert.deepEqual(plan.words, [{ language: "en", words: [PLAN_WORD, "grain elevator"] }]);
  const queries = await db().signalResearchQuery.findMany({
    where: { planId: plan.id },
    orderBy: { position: "asc" },
  });
  assert.deepEqual(
    queries.map(({ placeId, country, language, resultCount }) => [
      placeId,
      country,
      language,
      resultCount,
    ]),
    [
      ["web_search", "DE", "en", 3],
      ["association_members", "DE", "en", 3],
    ],
  );
  assert.ok(queries.every(({ askedAt }) => askedAt !== null));
  assert.deepEqual(
    searched(),
    PLAN_QUERIES.map((query) => ({ query, count: 10, country: "DE", language: "en", page: 1 })),
  );
  const kept = await files.list({ workspaceId, prefix: `raw/signals/${requested.id}/` });
  assert.deepEqual(
    kept.files.map(({ key }) => key.replace(`w/${workspaceId}/`, "")),
    [
      `raw/signals/${requested.id}/judge/queue.json`,
      `raw/signals/${requested.id}/pages/queue.json`,
      `raw/signals/${requested.id}/people/queue.json`,
      ...[1, 2].map((position) => `raw/signals/${requested.id}/pick/${position}.json`),
      ...[1, 2].map((position) => `raw/signals/${requested.id}/search/${position}.json`),
    ],
  );
  const history = await historyOf(workflowId);
  for (const secret of [WORDS, PLAN_WORD, PLAN_QUERY, "association_members", "grain elevator"]) {
    assert.ok(!history.includes(secret), `the history holds ${secret}`);
  }
  assert.ok(!history.includes("DE"), "the history holds the audience");
  assert.ok(!history.includes("silo-"), "the history holds a result");

  // A second run of the same source asks none of the first run's queries: the plan's gate refuses
  // each as asked, so nothing is searched and the run still ends done.
  const asked = search.recordedCalls.length;
  scriptPlan();
  const again = await inRun(workspaceId, () => requestRun(sourceId));
  assert.equal((await researchRun(workspaceId, sourceId, again.id)).status, "done");
  assert.deepEqual((await rowOf(again.id)).counts, { queries_refused: 2 });
  assert.equal(search.recordedCalls.length, asked, "a query asked before was searched again");
});

test("at SIGNALS_RESEARCH_SEARCHES_PER_RUN (3 here) the run searches three queries of five and ends done with counts.budget_reached; with every adapter spent after the first search it ends done with counts.adapters_spent and its other queries unasked; with no adapter loaded it ends failed with research_search_unavailable and keeps its plan", async () => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const limited = await researchOf(tenant, "Limited");
  scriptPlan("DE", 5);
  scriptNoPicks(3);
  seedSearch(5);
  const first = await inRun(workspaceId, () => requestRun(limited.sourceId));
  assert.equal((await researchRun(workspaceId, limited.sourceId, first.id)).status, "done");
  assert.deepEqual((await rowOf(first.id)).counts, {
    ...{ queries_planned: 5, searches_asked: 3, search_results: 9 },
    budget_reached: 1,
  });
  assert.equal(searched().length, 3);
  const asked = await db().signalResearchQuery.count({
    where: { sourceId: limited.sourceId, askedAt: { not: null } },
  });
  assert.equal(asked, 3);

  search.reset();
  const spent = await researchOf(tenant, "Spent");
  scriptPlan("DE", 2);
  scriptNoPicks(1);
  seedSearch(2);
  // Three searches of this day are counted already (the run above): one more is allowed.
  search.setAllowance({ calls: 4, per: "day" });
  const second = await inRun(workspaceId, () => requestRun(spent.sourceId));
  assert.equal((await researchRun(workspaceId, spent.sourceId, second.id)).status, "done");
  assert.deepEqual((await rowOf(second.id)).counts, {
    ...{ queries_planned: 2, searches_asked: 1, search_results: 3 },
    adapters_spent: 1,
  });

  search.reset();
  enrichment.useWebSearchAdapters([]);
  const bare = await researchOf(tenant, "Bare");
  scriptPlan("DE", 2);
  const workflowId = `signals_research_run-${randomUUID()}`;
  const third = await inRun(workspaceId, () => requestRun(bare.sourceId));
  const ended = await researchRun(workspaceId, bare.sourceId, third.id, workflowId);
  assert.deepEqual(ended, {
    runId: third.id,
    status: "failed",
    code: "research_search_unavailable",
  });
  const row = await rowOf(third.id);
  assert.deepEqual(
    [row.status, row.error, row.counts],
    ["failed", "research_search_unavailable", { queries_planned: 2 }],
  );
  assert.equal(await db().signalResearchQuery.count({ where: { sourceId: bare.sourceId } }), 2);
  assert.ok((await historyOf(workflowId)).includes("research_search_unavailable"));
});

test("an audience that names no country ends the run failed with research_no_country: a source in no agent reads the workspace's default, a source in an agent its agent's, which ends done with a country; the history carries the code, not the audience", async () => {
  const { tenant, workspaceId } = await workspaceIn([]);
  const none = await researchOf(tenant, "No country", { agent: false });
  const run = await inRun(workspaceId, () => requestRun(none.sourceId));
  const asked = llm.recordedCalls.length;
  const workflowId = `signals_research_run-${randomUUID()}`;
  const ended = await researchRun(workspaceId, none.sourceId, run.id, workflowId);
  assert.deepEqual(ended, { runId: run.id, status: "failed", code: "research_no_country" });
  const row = await rowOf(run.id);
  assert.deepEqual([row.status, row.error, row.counts], ["failed", "research_no_country", {}]);
  assert.ok(row.finishedAt !== null);
  assert.ok((await historyOf(workflowId)).includes("research_no_country"));
  assert.equal(
    llm.recordedCalls.length,
    asked,
    "the model was asked for a run with nowhere to look",
  );
  scriptPlan("FR");
  const coast = await researchOf(tenant, "Coast", { countries: ["FR"] });
  const second = await inRun(workspaceId, () => requestRun(coast.sourceId));
  assert.equal((await researchRun(workspaceId, coast.sourceId, second.id)).status, "done");
  // An agent with no country fails where the default has one.
  await inRun(workspaceId, async (tx) => {
    const { id } = (await icp.readIcpForScoring(workspaceId)).icp;
    await tx.icp.update({ where: { id }, data: { countries: ["DE"] } });
  });
  const empty = await researchOf(tenant, "Empty", { countries: [] });
  const third = await inRun(workspaceId, () => requestRun(empty.sourceId));
  const failed = await researchRun(workspaceId, empty.sourceId, third.id);
  assert.equal(failed.code, "research_no_country");
});

test("a paused agent's source gets no run by Run now and a row written before the pause ends cancelled, never started; a source gone before its run starts ends the workflow gone", async () => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const { sourceId, playbookId } = await researchOf(tenant, "Paused");
  const written = await inRun(workspaceId, () => requestRun(sourceId));
  await inRun(workspaceId, () => updatePlaybook(playbookId as string, { status: "paused" }));
  const refused = inRun(workspaceId, () => requestRun(sourceId));
  await assert.rejects(refused, { code: "signal_agent_paused", status: 409 });
  assert.deepEqual(await researchRun(workspaceId, sourceId, written.id), {
    runId: written.id,
    status: "gone",
  });
  const row = await rowOf(written.id);
  assert.deepEqual([row.status, row.startedAt, row.finishedAt !== null], ["cancelled", null, true]);
  const lone = await researchRun(workspaceId, "src_gone", "run_gone");
  assert.deepEqual(lone, { runId: "run_gone", status: "gone" });
});

test("a stop asked before the run's first step ends its row cancelled, never started, and the workflow gone: the step runs to its end as every run's does, whatever the cancel asked meanwhile", async () => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const { sourceId } = await researchOf(tenant, "Stopped", { agent: false });
  const run = await inRun(workspaceId, () => requestRun(sourceId));
  let arrive = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  held = { arrive, gate };
  const workflowId = `signals.run:${workspaceId}:${run.id}`;
  const input = { workspaceId, sourceId, runId: run.id };
  const handle = await start("signals_research_run", input, workflowId);
  await reached;
  await inRun(workspaceId, () => stopRun(sourceId, run.id));
  await handle.cancel();
  release();
  assert.deepEqual(await handle.result(), { runId: run.id, status: "gone" });
  const row = await rowOf(run.id);
  assert.deepEqual([row.status, row.startedAt], ["cancelled", null]);
  assert.ok(row.finishedAt !== null && row.stopRequestedAt !== null);
});

test("the daily tick writes a run for a research source in an active agent that is due, and none for a source in no agent, one that ran within the days, a paused agent's or a disabled one; the run it wrote ends done, and the next tick writes none", async () => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const due = await researchOf(tenant, "Due");
  const noAgent = await researchOf(tenant, "No agent", { agent: false });
  const recent = await researchOf(tenant, "Recent");
  const paused = await researchOf(tenant, "Paused");
  const disabled = await researchOf(tenant, "Disabled");
  const created = { workspaceId, kind: "web_research", status: "done" as const };
  await signals.createSignalRun({
    ...created,
    sourceId: recent.sourceId,
    startedAt: new Date(Date.now() - DAY_MS),
  });
  await inRun(workspaceId, () => updatePlaybook(paused.playbookId as string, { status: "paused" }));
  await db().signalSource.update({ where: { id: disabled.sourceId }, data: { enabled: false } });
  const tick = await execute<Tick>("signals_daily_runs_tick", {});
  assert.deepEqual(tick, { workspaces: 2, started: 1 });
  const scheduled = await db().signalRun.findMany({ where: { workspaceId, status: "scheduled" } });
  assert.deepEqual(
    scheduled.map(({ sourceId }) => sourceId),
    [due.sourceId],
  );
  const written = scheduled[0] as (typeof scheduled)[number];
  scriptPlan();
  const ended = await researchRun(workspaceId, due.sourceId, written.id);
  assert.equal(ended.status, "done");
  for (const source of [noAgent, recent, paused, disabled]) {
    const found = await db().signalRun.count({
      where: { sourceId: source.sourceId, status: "scheduled" },
    });
    assert.equal(found, 0);
  }
  assert.deepEqual(await execute<Tick>("signals_daily_runs_tick", {}), {
    workspaces: 2,
    started: 0,
  });
});

test("a plan the model fails twice ends the run failed with research_plan_failed, keeping no plan; a plan with every query refused by the gates ends it done with its counts", async () => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const failing = await researchOf(tenant, "Failing");
  const run = await inRun(workspaceId, () => requestRun(failing.sourceId));
  llm.script("not JSON", { words: "nothing" });
  const workflowId = `signals_research_run-${randomUUID()}`;
  const ended = await researchRun(workspaceId, failing.sourceId, run.id, workflowId);
  assert.deepEqual(ended, { runId: run.id, status: "failed", code: "research_plan_failed" });
  const row = await rowOf(run.id);
  assert.deepEqual([row.status, row.error, row.counts], ["failed", "research_plan_failed", {}]);
  assert.equal(await db().signalResearchPlan.count({ where: { runId: run.id } }), 0);
  assert.ok((await historyOf(workflowId)).includes("research_plan_failed"));
  // Every query off the audience's countries: refused, the run still done, its counts saying so.
  const refused = await researchOf(tenant, "Refused");
  const second = await inRun(workspaceId, () => requestRun(refused.sourceId));
  scriptPlan("FR");
  const done = await researchRun(workspaceId, refused.sourceId, second.id);
  assert.equal(done.status, "done");
  assert.deepEqual((await rowOf(second.id)).counts, { queries_refused: 2 });
});

test("the run picks the results of each search and reads the pages: the start page first, then the picks round by round, a page its robots.txt closes and a LinkedIn result never requested, a PDF file read as text, a few pages of one host at most; at SIGNALS_RESEARCH_PAGES_PER_RUN (4 here) the run ends done with counts.budget_reached; each page is a file under the run's pages folder, and the history holds ids, counts and codes, never a link, a page's text or a company's name", async (t) => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const options = { startPages: ["https://nord.example/"] };
  const { sourceId } = await researchOf(tenant, "Pages", options);
  scriptPlan();
  // The first search's results: LinkedIn's is dropped in code, so the model sees three, numbered 1 to
  // 3; the second's: two. The picks are the likeliest first.
  const first = [
    "https://fair.example/exhibitors",
    "https://nord.example/about",
    "https://www.linkedin.com/company/quillon-mills",
    "https://nord.example/team",
  ];
  const second = ["https://closed.example/private/list", "https://fair.example/files/award.pdf"];
  [first, second].forEach((urls, at) =>
    search.seedResults(
      PLAN_QUERIES[at] ?? "",
      urls.map((url) => ({ url, title: "Made-up page", snippet: "" })),
    ),
  );
  llm.script(
    { picks: [{ index: 1 }, { index: 2 }, { index: 3 }] },
    { picks: [{ index: 1 }, { index: 2 }] },
    // The four pages read, none of which names a company.
    ...Array.from({ length: 4 }, () => ({ is: "other", companies: [] })),
  );
  const row = await inRun(workspaceId, () => requestRun(sourceId));
  const workflowId = `signals_research_run_pages-${randomUUID()}`;
  // The run whose history is workflows/__histories__/signals_research_run_pages.json (history:record).
  t.diagnostic(`signals_research_run ran as ${workflowId}`);
  const done = await researchRun(workspaceId, sourceId, row.id, workflowId);
  assert.deepEqual(done, { runId: row.id, status: "done" });
  assert.deepEqual((await rowOf(row.id)).counts, {
    ...{ queries_planned: 2, searches_asked: 2, search_results: 6 },
    ...{ pages_picked: 5, results_dropped: 1, pages: 4, pages_closed: 1, budget_reached: 1 },
    pages_empty: 4,
  });
  // The start page, then each search's likeliest, then the next: the closed page is asked for its
  // robots.txt and nothing else; the run stops at four pages read, the sixth page of the queue unread.
  assert.deepEqual(
    served.filter((made) => !made.endsWith("/robots.txt")),
    [
      "nord.example/",
      "fair.example/exhibitors",
      "nord.example/about",
      "fair.example/files/award.pdf",
    ],
  );
  assert.equal(served.filter((made) => made === "nord.example/robots.txt").length, 1);
  assert.ok(served.includes("closed.example/robots.txt"));
  assert.ok(!served.some((made) => made.includes("private") || made.includes("linkedin")));
  const kept = await files.list({ workspaceId, prefix: `raw/signals/${row.id}/pages/` });
  assert.deepEqual(
    kept.files.map(({ key }) => key.replace(`w/${workspaceId}/`, "")),
    ["1.json", "2.json", "4.json", "5.json", "queue.json"].map(
      (name) => `raw/signals/${row.id}/pages/${name}`,
    ),
  );
  const history = await historyOf(workflowId);
  for (const secret of ["nord.example", "fair.example", "linkedin", "Quillon", "refrigerated"]) {
    assert.ok(!history.includes(secret), `the history holds ${secret}`);
  }
  const plan = await db().signalResearchPlan.findFirstOrThrow({ where: { runId: row.id } });
  assert.equal(plan.runId, row.id);
});

test("the run says what each page it read is and makes candidates of the companies they name: a company's own site, the two companies of a list page and the company an award notice in a PDF file names without a link, whose site is found by its name inside the searches' limit; each with its page, source type and quote; a second run checks the candidates left against the never-contact list, drops the one now on it, counts the rest carried and makes none again; the history holds ids, counts and codes, never a name, a link or a quote", async (t) => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const { sourceId } = await researchOf(tenant, "Candidates", {
    startPages: ["https://nord.example/"],
  });
  scriptPlan();
  const lists = ["https://fair.example/list", "https://fair.example/files/award.pdf"];
  lists.forEach((url, at) =>
    search.seedResults(PLAN_QUERIES[at] ?? "", [{ url, title: "Made-up page", snippet: "" }]),
  );
  search.seedResults('"Quillon Mills" Brno', [
    { url: "https://quillon-mills.example/", title: "Quillon Mills: steel", snippet: "" },
    { url: "https://www.facebook.com/quillon", title: "Quillon Mills - Facebook", snippet: "" },
  ]);
  const company = (name: string, extra: object = {}) => ({
    ...{ name, link: null, place: null, line: null, quote: null },
    ...extra,
  });
  llm.script(
    { picks: [{ index: 1 }] },
    { picks: [{ index: 1 }] },
    // The start page (a company's own site), the list page, the notice in the PDF file.
    {
      is: "company_site",
      companies: [
        company("Nord Cold Chain Ltd", {
          line: "A refrigerated vehicle seller.",
          quote: "A made-up company that sells and services refrigerated vehicles",
        }),
      ],
    },
    {
      is: "company_list",
      companies: [
        company("Brno Cold Storage s.r.o.", {
          link: "https://brno-cold.example/",
          place: "Brno",
          line: "Stores and distributes chilled food.",
          quote: "cold storage and distribution of chilled food",
        }),
        company("Moravia Reefer Trans", {
          link: "https://moravia-reefer.example/",
          place: "Ostrava",
        }),
        company("Invented Holdings", { link: "https://invented.example/" }),
      ],
    },
    {
      is: "notice",
      companies: [
        company("Quillon Mills", {
          place: "Brno",
          line: "Won the contract in an award notice.",
          quote: "the contract goes to Quillon Mills of Brno",
        }),
      ],
    },
  );
  const first = await inRun(workspaceId, () => requestRun(sourceId));
  const workflowId = `signals_research_run_candidates-${randomUUID()}`;
  // The run whose history is workflows/__histories__/signals_research_run_candidates.json (history:record).
  t.diagnostic(`signals_research_run ran as ${workflowId}`);
  assert.deepEqual(await researchRun(workspaceId, sourceId, first.id, workflowId), {
    runId: first.id,
    status: "done",
  });
  assert.deepEqual((await rowOf(first.id)).counts, {
    ...{ queries_planned: 2, searches_asked: 3, search_results: 2, pages_picked: 2, pages: 3 },
    ...{ candidates: 4, refused_name: 1, sites_not_read: 4 },
  });
  // The one search by name is asked as a query of the plan's, with its name and its place and no more.
  assert.deepEqual(searched().slice(2), [{ query: '"Quillon Mills" Brno', count: 5 }]);
  const rows = await db().signalResearchCandidate.findMany({
    where: { sourceId },
    orderBy: { createdAt: "asc" },
  });
  assert.deepEqual(
    rows.map(({ name, domain, state, placeId, place, line, quote }) => ({
      ...{ name, domain, state, placeId, place, line, quote },
    })),
    [
      {
        ...{ name: "Nord Cold Chain Ltd", domain: "nord.example", state: "dropped" },
        ...{ placeId: null, place: null, line: "A refrigerated vehicle seller." },
        quote: "A made-up company that sells and services refrigerated vehicles",
      },
      {
        ...{ name: "Brno Cold Storage s.r.o.", domain: "brno-cold.example", state: "dropped" },
        ...{ placeId: "web_search", place: "Brno", line: "Stores and distributes chilled food." },
        quote: "cold storage and distribution of chilled food",
      },
      {
        ...{ name: "Moravia Reefer Trans", domain: "moravia-reefer.example" },
        ...{ state: "dropped", placeId: "web_search", place: "Ostrava", line: null, quote: null },
      },
      {
        ...{ name: "Quillon Mills", domain: "quillon-mills.example", state: "dropped" },
        ...{ placeId: "association_members", place: "Brno" },
        ...{
          line: "Won the contract in an award notice.",
          quote: "the contract goes to Quillon Mills of Brno",
        },
      },
    ],
  );
  assert.ok(rows[3]?.pageUrl.endsWith("/files/award.pdf"));
  // Each candidate keeps the query whose results led to its page (gamma-wr-051); a start page has none.
  const queries = await db().signalResearchQuery.findMany({
    where: { sourceId },
    orderBy: { position: "asc" },
  });
  assert.deepEqual(
    rows.map(({ queryId }) => queryId),
    [null, queries[0]?.id, queries[0]?.id, queries[1]?.id],
  );
  const history = await historyOf(workflowId);
  for (const secret of [
    "Nord Cold",
    "Brno",
    "Quillon",
    "Moravia",
    "brno-cold",
    "moravia",
    "quote",
  ]) {
    assert.ok(!history.includes(secret), `the history holds ${secret}`);
  }

  // Their sites are no local ones, so each is dropped as unreadable after its candidate is made; the
  // earlier runs' leftovers, as a limit would leave them, are put back as pending for the next run.
  await db().signalResearchCandidate.updateMany({
    where: { sourceId },
    data: { state: "pending", dropCode: null },
  });
  // The next run: Brno Cold Storage joins the never-contact list; the run checks the three others'
  // left pending again and drops it, counts the rest carried, and its own read of the start page
  // makes no candidate of a company the source holds.
  await inRun(workspaceId, () =>
    contacts.addSuppression({ kind: "company", value: "brno-cold.example", createdBy: "usr_test" }),
  );
  scriptPlan();
  llm.script({ is: "company_site", companies: [company("Nord Cold Chain Ltd")] });
  const next = await inRun(workspaceId, () => requestRun(sourceId));
  assert.equal((await researchRun(workspaceId, sourceId, next.id)).status, "done");
  assert.deepEqual((await rowOf(next.id)).counts, {
    ...{ queries_refused: 2, pages: 1, candidates_carried: 3, dropped_never_contact: 1 },
    ...{ candidates_known: 1, sites_not_read: 3 },
  });
  const left = await db().signalResearchCandidate.findMany({
    where: { sourceId, state: "dropped", dropCode: { not: "never_contact" } },
    orderBy: { createdAt: "asc" },
  });
  assert.deepEqual(
    left.map(({ domain }) => domain),
    ["nord.example", "moravia-reefer.example", "quillon-mills.example"],
  );
  const dropped = await db().signalResearchCandidate.findFirstOrThrow({
    where: { sourceId, domain: "brno-cold.example" },
  });
  assert.deepEqual([dropped.state, dropped.dropCode], ["dropped", "never_contact"]);
});

test("the run reads each candidate's site, has the judge answer and decides the verdict in code: a site that shows the focus is fit, its found company and its company in contacts are kept, a second run judges none of the first run's; the history holds ids, counts and codes, never a name, a quote or an address", async (t) => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const { sourceId } = await researchOf(tenant, "Judged", {
    startPages: ["https://nord.example/"],
  });
  sitesLocal = true;
  scriptPlan();
  const company = (name: string) => ({
    ...{ name, link: null, place: null, line: null, quote: null },
  });
  llm.script(
    { is: "company_site", companies: [company("Nord Cold Chain Ltd")] },
    {
      focus: {
        answer: "shown",
        line: "Sells refrigerated vehicles.",
        quote: "sells and services refrigerated vehicles for food traders",
        page: 1,
      },
      mustHaves: [],
      disqualifiers: [],
      industry: { answer: "not_stated", line: null, quote: null, page: null },
      size: { answer: "not_stated", line: null, quote: null, page: null },
      country: null,
      town: null,
      state: null,
      onePerson: { answer: "not_stated", line: null, quote: null, page: null },
      email: null,
      phones: [],
      postal: null,
    },
    // The fit company's people: the page names none the model reads.
    { people: [] },
  );
  const first = await inRun(workspaceId, () => requestRun(sourceId));
  const workflowId = `signals_research_run_judge-${randomUUID()}`;
  // The run whose history is workflows/__histories__/signals_research_run_judge.json (history:record).
  t.diagnostic(`signals_research_run ran as ${workflowId}`);
  assert.deepEqual(await researchRun(workspaceId, sourceId, first.id, workflowId), {
    runId: first.id,
    status: "done",
  });
  const counts = (await rowOf(first.id)).counts as Record<string, number>;
  assert.equal(counts.companies_judged, 1);
  assert.equal(counts.companies_fit, 1);
  const found = await db().signalFoundCompany.findMany({ where: { sourceId } });
  const rows = await db().signalResearchCandidate.findMany({ where: { sourceId } });
  assert.deepEqual(
    found.map(({ domain, verdict, runId }) => [domain, verdict, runId]),
    [["nord.example", "fit", first.id]],
  );
  const reasons = found[0]?.reasons as { kind: string; answer: string }[];
  assert.deepEqual(
    reasons.map(({ kind, answer }) => [kind, answer]),
    [["focus", "shown"]],
  );
  assert.notEqual(found[0]?.companyId, null);
  // The one company judged cost one signals.researched_company, committed, and none is left open.
  const usage = await db().creditUsage.findMany({ where: { workspaceId } });
  assert.deepEqual(
    usage.map(({ action, status, subjectRef }) => [action, status, subjectRef]),
    [["signals.researched_company", "committed", rows[0]?.id]],
  );
  const history = await historyOf(workflowId);
  for (const secret of ["Nord", "refrigerated", "nord.example"]) {
    assert.ok(!history.includes(secret), `the history holds ${secret}`);
  }

  // The next run judges none of the first run's: its candidate is judged, nothing is left to judge.
  scriptPlan();
  llm.script({ is: "company_site", companies: [company("Nord Cold Chain Ltd")] });
  const next = await inRun(workspaceId, () => requestRun(sourceId));
  assert.equal((await researchRun(workspaceId, sourceId, next.id)).status, "done");
  assert.equal(
    ((await rowOf(next.id)).counts as Record<string, number>).companies_judged,
    undefined,
  );
  assert.equal(await db().signalFoundCompany.count({ where: { sourceId } }), 1);
});

test("a company a member marked Not a fit is not read or judged by the next run, past the re-check days too: its candidate is left as it was and counted dropped_not_fit, no site is read, the model is not asked to judge, nothing is charged again and its row, with the member's mark, is as it was (gamma-wr-110)", async () => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const { sourceId } = await researchOf(tenant, "Marked", {
    startPages: ["https://nord.example/"],
  });
  sitesLocal = true;
  scriptPlan();
  const company = (name: string) => ({ name, link: null, place: null, line: null, quote: null });
  const none = { answer: "not_stated", line: null, quote: null, page: null };
  llm.script(
    { is: "company_site", companies: [company("Nord Cold Chain Ltd")] },
    {
      ...{ mustHaves: [], disqualifiers: [], industry: none, size: none, onePerson: none },
      ...{ country: null, town: null, state: null, email: null, phones: [], postal: null },
      focus: {
        answer: "shown",
        line: "Sells refrigerated vehicles.",
        quote: "sells and services refrigerated vehicles for food traders",
        page: 1,
      },
    },
    // The fit company's people: the page names none the model reads.
    { people: [] },
  );
  const first = await inRun(workspaceId, () => requestRun(sourceId));
  assert.equal((await researchRun(workspaceId, sourceId, first.id)).status, "done");
  const judged = await db().signalFoundCompany.findFirstOrThrow({ where: { sourceId } });
  assert.equal(judged.verdict, "fit");
  // The member marks it Not a fit, and a year goes by: its candidate is older than the re-check days.
  await inRun(workspaceId, () => markNotFit(judged.id));
  const old = new Date(Date.now() - 400 * DAY_MS);
  await db().signalResearchCandidate.updateMany({ where: { sourceId }, data: { stateAt: old } });
  llm.reset();
  scriptPlan();
  llm.script({ is: "company_site", companies: [company("Nord Cold Chain Ltd")] });
  const next = await inRun(workspaceId, () => requestRun(sourceId));
  assert.equal((await researchRun(workspaceId, sourceId, next.id)).status, "done");
  const counts = (await rowOf(next.id)).counts as Record<string, number>;
  assert.equal(counts.dropped_not_fit, 1);
  assert.deepEqual(
    [counts.companies_judged, counts.sites_not_read, counts.candidates],
    [undefined, undefined, undefined],
  );
  // The model was asked the page's read and no judgment: no call carries a company's site.
  const asked = JSON.stringify(llm.recordedCalls.map(({ input }) => input));
  assert.ok(!asked.includes("<site>"), "no call carries a company's site");
  const row = await db().signalFoundCompany.findFirstOrThrow({ where: { sourceId } });
  assert.deepEqual(
    [row.verdict, row.memberMark, row.runId, row.judgedAt.getTime()],
    ["not_fit", "not_fit", first.id, judged.judgedAt.getTime()],
  );
  const candidate = await db().signalResearchCandidate.findFirstOrThrow({ where: { sourceId } });
  assert.deepEqual([candidate.state, candidate.stateAt.getTime()], ["read", old.getTime()]);
  const usage = await db().creditUsage.findMany({ where: { workspaceId } });
  assert.equal(usage.length, 1, "only the first run's company was charged");
});

test("a refused credit ends the run failed with insufficient_credits, keeping the companies judged before it: with one credit the first company is judged and charged, the second is not read, its candidate stays pending and no reservation is left open; the history holds the code, not a name", async (t) => {
  const { tenant, workspaceId } = await workspaceIn(["DE"], 1);
  const { sourceId } = await researchOf(tenant, "Short", {
    startPages: ["https://nord.example/", "https://closed.example/"],
  });
  sitesLocal = true;
  scriptPlan();
  const company = (name: string) => ({ name, link: null, place: null, line: null, quote: null });
  const none = { answer: "not_stated", line: null, quote: null, page: null };
  llm.script(
    { is: "company_site", companies: [company("Nord Cold Chain Ltd")] },
    { is: "company_site", companies: [company("closed.example")] },
    {
      ...{ mustHaves: [], disqualifiers: [], industry: none, size: none, onePerson: none },
      ...{ country: null, town: null, state: null, email: null, phones: [], postal: null },
      focus: {
        answer: "shown",
        line: "Sells refrigerated vehicles.",
        quote: "sells and services refrigerated vehicles for food traders",
        page: 1,
      },
    },
  );
  const first = await inRun(workspaceId, () => requestRun(sourceId));
  const workflowId = `signals_research_run_credits-${randomUUID()}`;
  t.diagnostic(`signals_research_run ran as ${workflowId}`);
  assert.deepEqual(await researchRun(workspaceId, sourceId, first.id, workflowId), {
    runId: first.id,
    status: "failed",
    code: "insufficient_credits",
  });
  const row = await rowOf(first.id);
  assert.deepEqual([row.status, row.error], ["failed", "insufficient_credits"]);
  assert.equal((row.counts as Record<string, number>).companies_judged, 1);
  assert.deepEqual(
    (await db().signalFoundCompany.findMany({ where: { sourceId } })).map(({ domain }) => domain),
    ["nord.example"],
  );
  const pending = await db().signalResearchCandidate.findMany({
    where: { sourceId, state: "pending" },
  });
  assert.deepEqual(
    pending.map(({ domain }) => domain),
    ["closed.example"],
  );
  const usage = await db().creditUsage.findMany({ where: { workspaceId } });
  assert.deepEqual(
    usage.map(({ action, status }) => [action, status]),
    [["signals.researched_company", "committed"]],
  );
  const balance = await db().creditBalance.findFirstOrThrow();
  assert.equal(Number(balance.reserved), 0);
  const history = await historyOf(workflowId);
  for (const secret of ["Nord", "refrigerated", "closed.example"]) {
    assert.ok(!history.includes(secret), `the history holds ${secret}`);
  }
});

test("the run reads the people a fit company's pages name, has the pick choose among their roles alone and makes the picked person with an address at the company's domain a pending lead of the source with its event; the history, the log and the files hold ids, counts and codes, never a name, a role, an address or a link; a second run adds nobody", async (t) => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const { sourceId } = await researchOf(tenant, "People", {
    startPages: ["https://nord.example/"],
    titles: ["Head of Sales"],
  });
  sitesLocal = true;
  scriptPlan();
  const company = (name: string) => ({
    ...{ name, link: null, place: null, line: null, quote: null },
  });
  const none = { answer: "not_stated", line: null, quote: null, page: null };
  llm.script(
    { is: "company_site", companies: [company("Nord Cold Chain Ltd")] },
    {
      focus: {
        answer: "shown",
        line: "Sells refrigerated vehicles.",
        quote: "sells and services refrigerated vehicles for food traders",
        page: 1,
      },
      ...{ mustHaves: [], disqualifiers: [], industry: none, size: none },
      ...{ country: null, town: null, state: null, onePerson: none },
      ...{ email: null, phones: [], postal: null },
    },
    {
      people: [
        {
          ...{ page: 1, name: "Karla Nordmann", role: "Head of Sales" },
          ...{ profile: null, email: "karla.nordmann@nord.example", phone: null, place: null },
        },
        {
          ...{ page: 1, name: "Hans Nordstern", role: "Office Assistant" },
          ...{ profile: null, email: null, phone: null, place: null },
        },
      ],
    },
    { picks: [{ index: 1 }] },
  );
  const first = await inRun(workspaceId, () => requestRun(sourceId));
  const workflowId = `signals_research_run_people-${randomUUID()}`;
  // The run whose history is workflows/__histories__/signals_research_run_people.json (history:record).
  t.diagnostic(`signals_research_run ran as ${workflowId}`);
  assert.deepEqual(await researchRun(workspaceId, sourceId, first.id, workflowId), {
    runId: first.id,
    status: "done",
  });
  const counts = (await rowOf(first.id)).counts as Record<string, number>;
  assert.deepEqual(
    [counts.companies_fit, counts.people_companies, counts.people_read, counts.people_picked],
    [1, 1, 2, 1],
  );
  assert.deepEqual([counts.people_found, counts.people_no_key], [1, undefined]);
  const persons = await db().person.findMany({ where: { workspaceId } });
  assert.deepEqual(
    persons.map(({ firstName, lastName, title }) => [firstName, lastName, title]),
    [["Karla", "Nordmann", "Head of Sales"]],
  );
  const lead = await db().lead.findFirstOrThrow({ where: { workspaceId } });
  assert.deepEqual([lead.qualificationStatus, lead.sourceLabel], ["pending", "signal"]);
  const events = await db().signalEvent.findMany({ where: { workspaceId } });
  assert.deepEqual(
    events.map(({ kind, personId, sourceId: at }) => [kind, personId, at]),
    [["web_research", persons[0]?.id, sourceId]],
  );
  assert.equal(
    (await db().signalFoundCompany.findFirstOrThrow({ where: { sourceId } })).peopleTakenAt !==
      null,
    true,
  );
  // The pick saw the roles and the audience's titles, never a name or an address.
  const text = JSON.stringify(llm.recordedCalls.at(-1)?.input);
  assert.ok(text.includes("Head of Sales") && text.includes("Office Assistant"));
  for (const hidden of ["Karla", "Nordmann", "Hans", "Nordstern", "karla.nordmann", "nord.example"])
    assert.ok(!text.includes(hidden), `the pick saw ${hidden}`);
  // The history, the log and the run's files hold none of them.
  const secrets = ["Karla", "Nordmann", "Hans", "Nordstern", "Head of Sales", "Office Assistant"];
  const history = await historyOf(workflowId);
  for (const secret of [...secrets, "karla.nordmann", "nord.example"])
    assert.ok(!history.includes(secret), `the history holds ${secret}`);
  const logged = JSON.stringify(logs.lines());
  for (const secret of [...secrets, "karla.nordmann"])
    assert.ok(!logged.includes(secret), `the log holds ${secret}`);
  const kept = await files.list({ workspaceId, prefix: `raw/signals/${first.id}/people` });
  assert.equal(kept.files.length, 1);
  assert.ok(kept.files.every(({ key }) => !secrets.some((secret) => key.includes(secret))));

  // The next run adds nobody and asks no model for people.
  scriptPlan();
  llm.script({ is: "company_site", companies: [company("Nord Cold Chain Ltd")] });
  const next = await inRun(workspaceId, () => requestRun(sourceId));
  assert.equal((await researchRun(workspaceId, sourceId, next.id)).status, "done");
  assert.equal(((await rowOf(next.id)).counts as Record<string, number>).people_found, undefined);
  assert.equal(await db().person.count({ where: { workspaceId } }), 1);
  assert.equal(await db().signalEvent.count({ where: { workspaceId } }), 1);
});

test("a person whose page prints a direct line has the number kept with the page and shown on the lead page's route: a phone contact point, no verification, never an address; the company's own line is not kept for them; the run counts it, and the history, the log and the files hold no digit of it (gamma-wr-100)", async (t) => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const { sourceId } = await researchOf(tenant, "Phones", {
    startPages: ["https://nord.example/"],
    titles: ["Head of Sales"],
  });
  sitesLocal = true;
  scriptPlan();
  const company = (name: string) => ({
    ...{ name, link: null, place: null, line: null, quote: null },
  });
  const none = { answer: "not_stated", line: null, quote: null, page: null };
  llm.script(
    { is: "company_site", companies: [company("Nord Cold Chain Ltd")] },
    {
      focus: {
        answer: "shown",
        line: "Sells refrigerated vehicles.",
        quote: "sells and services refrigerated vehicles for food traders",
        page: 1,
      },
      ...{ mustHaves: [], disqualifiers: [], industry: none, size: none },
      ...{ country: null, town: null, state: null, onePerson: none },
      ...{ email: null, phones: [], postal: null },
    },
    {
      people: [
        {
          ...{ page: 1, name: "Karla Nordmann", role: "Head of Sales" },
          ...{ profile: null, email: "karla.nordmann@nord.example", place: null },
          phone: "+49 30 5550 1234",
        },
      ],
    },
    { picks: [{ index: 1 }] },
  );
  const first = await inRun(workspaceId, () => requestRun(sourceId));
  const workflowId = `signals_research_run_phone-${randomUUID()}`;
  t.diagnostic(`signals_research_run ran as ${workflowId}`);
  assert.deepEqual(await researchRun(workspaceId, sourceId, first.id, workflowId), {
    runId: first.id,
    status: "done",
  });
  const counts = (await rowOf(first.id)).counts as Record<string, number>;
  assert.deepEqual([counts.people_found, counts.people_phones], [1, 1]);
  const person = await db().person.findFirstOrThrow({ where: { workspaceId } });
  const points = await db().contactPoint.findMany({ where: { workspaceId } });
  assert.deepEqual(
    points.map(({ personId, kind, value, verification, verifiedAt }) => [
      ...[personId, kind, value, verification, verifiedAt],
    ]),
    [[person.id, "phone", "+493055501234", null, null]],
  );
  // The page that printed it: an address with no query.
  assert.match(points[0]?.pageUrl ?? "", /^https?:\/\/(nord\.example|127\.0\.0\.2:\d+)\/[^?#]*$/);
  // No number in the history, the log or a run file.
  const history = await historyOf(workflowId);
  const logged = JSON.stringify(logs.lines());
  for (const digits of ["5550", "1234", "+4930"]) {
    assert.ok(!history.includes(digits), `the history holds ${digits}`);
    assert.ok(!logged.includes(digits), `the log holds ${digits}`);
  }
  const kept = await files.list({ workspaceId, prefix: `raw/signals/${first.id}/people` });
  assert.ok(kept.files.every(({ key }) => !key.includes("5550")));
  // The pick saw roles only.
  assert.ok(!JSON.stringify(llm.recordedCalls.at(-1)?.input).includes("5550"));
});

test("a fit company whose pages name nobody gets one search for its managers on the search fake, limited to linkedin.com, whose words are the company's name and the plan's role words; the result code takes and the model reads becomes a pending lead with its profile, inside the run's searches' limit, with no request to LinkedIn; the history, the log and the run's counts hold ids, counts and codes, never a query, a name, a role or a link", async (t) => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const { sourceId } = await researchOf(tenant, "Managers", {
    startPages: ["https://nord.example/"],
    titles: ["Head of Sales"],
  });
  sitesLocal = true;
  llm.script({
    words: [{ language: "en", words: [PLAN_WORD] }],
    roleWords: [{ language: "en", words: ["head of sales", "purchasing manager"] }],
    places: ["web_search"],
    queries: [
      { place: "web_search", country: "DE", language: "en", text: PLAN_QUERIES[0] as string },
      { place: "web_search", country: "DE", language: "en", text: PLAN_QUERIES[1] as string },
    ],
  });
  const company = (name: string) => ({
    ...{ name, link: null, place: null, line: null, quote: null },
  });
  const none = { answer: "not_stated", line: null, quote: null, page: null };
  const query = '"Nord Cold Chain Ltd" ("head of sales" OR "purchasing manager")';
  search.seedResults(query, [
    {
      url: "https://www.linkedin.com/in/greta-lindqvist-nord",
      title: "Greta Lindqvist - Head of Sales - Nord Cold Chain Ltd | LinkedIn",
      snippet: "Head of Sales at Nord Cold Chain Ltd.",
    },
    {
      url: "https://www.linkedin.com/company/nord-cold-chain",
      title: "Nord Cold Chain Ltd | LinkedIn",
      snippet: "Refrigerated vehicles.",
    },
  ]);
  llm.script(
    { is: "company_site", companies: [company("Nord Cold Chain Ltd")] },
    {
      focus: {
        answer: "shown",
        line: "Sells refrigerated vehicles.",
        quote: "sells and services refrigerated vehicles for food traders",
        page: 1,
      },
      ...{ mustHaves: [], disqualifiers: [], industry: none, size: none },
      ...{ country: null, town: null, state: null, onePerson: none },
      ...{ email: null, phones: [], postal: null },
    },
    { people: [] },
    { people: [{ result: 1, name: "Greta Lindqvist", role: "Head of Sales" }] },
    { picks: [{ index: 1 }] },
  );
  const first = await inRun(workspaceId, () => requestRun(sourceId));
  const workflowId = `signals_research_run_managers-${randomUUID()}`;
  // The run whose history is workflows/__histories__/signals_research_run_managers.json (history:record).
  t.diagnostic(`signals_research_run ran as ${workflowId}`);
  assert.deepEqual(await researchRun(workspaceId, sourceId, first.id, workflowId), {
    runId: first.id,
    status: "done",
  });
  // The plan's two searches and the managers' one, on the fake, inside the limit of three.
  const asked = searched();
  assert.equal(asked.length, 3);
  assert.deepEqual([asked[2]?.query, asked[2]?.site, asked[2]?.count], [query, "linkedin.com", 10]);
  assert.equal(asked.filter(({ site }) => site === "linkedin.com").length, 1);
  assert.ok(!served.some((request) => request.includes("linkedin")), "no request to linkedin");
  const counts = (await rowOf(first.id)).counts as Record<string, number>;
  assert.deepEqual(
    [
      counts.managers_searches,
      counts.managers_results,
      counts.managers_people,
      counts.people_found,
    ],
    [1, 1, 1, 1],
  );
  const persons = await db().person.findMany({ where: { workspaceId } });
  assert.deepEqual(
    persons.map(({ firstName, lastName, title, linkedinUrl }) => [
      firstName,
      lastName,
      title,
      linkedinUrl,
    ]),
    [["Greta", "Lindqvist", "Head of Sales", "https://linkedin.com/in/greta-lindqvist-nord"]],
  );
  const lead = await db().lead.findFirstOrThrow({ where: { workspaceId } });
  assert.deepEqual([lead.qualificationStatus, lead.sourceLabel], ["pending", "signal"]);
  const evidence = await db().evidence.findFirstOrThrow({ where: { workspaceId } });
  assert.deepEqual([evidence.foundBy, evidence.url], ["managers", "https://nord.example/"]);
  // The history, the log and the counts hold none of the words.
  const secrets = ["Greta", "Lindqvist", "greta-lindqvist", "Head of Sales", "purchasing manager"];
  const history = await historyOf(workflowId);
  for (const secret of [...secrets, "Nord Cold Chain", "linkedin"])
    assert.ok(!history.includes(secret), `the history holds ${secret}`);
  const logged = JSON.stringify(logs.lines());
  for (const secret of secrets) assert.ok(!logged.includes(secret), `the log holds ${secret}`);
  assert.ok(!JSON.stringify(counts).includes("Greta"));
});

test("the run makes a picked person no page keyed a lead through a work address looked up for their name (gamma-wr-080): the finder and the verifier fakes are asked for that name and address only, the lead has the address as its key and its contact point, no lookup is asked and no request exists, the credit is committed by the found company and the person's place in the pick; the history, the log and the run's files hold neither the name nor the address; a second run adds nobody", async () => {
  const { tenant, workspaceId } = await workspaceIn(["DE"]);
  const { sourceId } = await researchOf(tenant, "Names", {
    startPages: ["https://nord.example/"],
    titles: ["Head of Purchasing"],
  });
  sitesLocal = true;
  scriptPlan();
  const company = (name: string) => ({
    ...{ name, link: null, place: null, line: null, quote: null },
  });
  const none = { answer: "not_stated", line: null, quote: null, page: null };
  llm.script(
    { is: "company_site", companies: [company("Nord Cold Chain Ltd")] },
    {
      focus: {
        answer: "shown",
        line: "Sells refrigerated vehicles.",
        quote: "sells and services refrigerated vehicles for food traders",
        page: 1,
      },
      ...{ mustHaves: [], disqualifiers: [], industry: none, size: none },
      ...{ country: null, town: null, state: null, onePerson: none },
      ...{ email: null, phones: [], postal: null },
    },
    {
      people: [
        {
          ...{ page: 1, name: "Ilse Nordhaus", role: "Head of Purchasing" },
          ...{ profile: null, email: null, phone: null, place: null },
        },
      ],
    },
    { picks: [{ index: 1 }] },
  );
  const first = await inRun(workspaceId, () => requestRun(sourceId));
  const workflowId = `signals_research_run_name-${randomUUID()}`;
  assert.deepEqual(await researchRun(workspaceId, sourceId, first.id, workflowId), {
    runId: first.id,
    status: "done",
  });
  const counts = (await rowOf(first.id)).counts as Record<string, number>;
  assert.deepEqual(
    [counts.people_found, counts.people_addresses, counts.people_no_key, counts.people_lookups],
    [1, 1, undefined, undefined],
  );
  const persons = await db().person.findMany({ where: { workspaceId } });
  assert.deepEqual(
    persons.map(({ firstName, lastName, linkedinUrl }) => [firstName, lastName, linkedinUrl]),
    [["Ilse", "Nordhaus", null]],
  );
  const point = await db().contactPoint.findFirstOrThrow({ where: { workspaceId } });
  assert.deepEqual(
    [point.personId, point.value, point.kind, point.verification, point.status],
    [persons[0]?.id, "ilse.nordhaus@nord.example", "work_email", "valid", "active"],
  );
  assert.equal(await db().lead.count({ where: { workspaceId } }), 1);
  assert.equal(await db().enrichmentRequest.count({ where: { workspaceId } }), 0);
  const found = await db().signalFoundCompany.findFirstOrThrow({ where: { sourceId } });
  assert.equal(found.peopleTakenAt !== null, true);
  const usage = await db().creditUsage.findMany({ where: { workspaceId } });
  const named = usage.find(({ action }) => action === "enrichment.work_email");
  assert.deepEqual([named?.status, named?.subjectRef], ["committed", found.id]);
  const balance = await db().creditBalance.findFirstOrThrow();
  assert.equal(Number(balance.reserved), 0);
  // Nothing of the name or the address is in the history, the log or a file of the run.
  const secrets = ["Ilse", "Nordhaus", "ilse.nordhaus", "Head of Purchasing"];
  const history = await historyOf(workflowId);
  for (const secret of secrets) assert.ok(!history.includes(secret), `the history holds ${secret}`);
  const logged = JSON.stringify(logs.lines());
  for (const secret of secrets) assert.ok(!logged.includes(secret), `the log holds ${secret}`);
  const kept = await files.list({ workspaceId, prefix: `raw/signals/${first.id}/` });
  assert.ok(kept.files.every(({ key }) => !secrets.some((secret) => key.includes(secret))));
  // The next run adds nobody and asks neither a finder nor a verifier again.
  scriptPlan();
  llm.script({ is: "company_site", companies: [company("Nord Cold Chain Ltd")] });
  const next = await inRun(workspaceId, () => requestRun(sourceId));
  assert.equal((await researchRun(workspaceId, sourceId, next.id)).status, "done");
  assert.equal(await db().person.count({ where: { workspaceId } }), 1);
  assert.equal(await db().contactPoint.count({ where: { workspaceId } }), 1);
});

test("the recorded histories of signals_research_run, the run of before its plan and the planned one, replay", () =>
  replayHistories(env.workflowsPath, HISTORIES));

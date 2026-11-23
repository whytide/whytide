// enrichment end to end (gamma-en-050; core/modules/enrichment/README.md "How it works"), on the
// slice's Temporal and a schema of its database, with enrichment's clock fixed: the module loaded from
// its build by the worker's own loader, its activities through the host's wrapper, on the
// company-data fake, a second fake adapter and two sources defined here. The tick through the host,
// its batch and a held lead's run, the company's empty fields filled with their class and adapter and
// the hold released; two adapters, the second asked only for what the first left empty; a source that
// adds a domain restarting the pass; a person with only a company's name; the instance's allowance
// shared by two workspaces and a vendor's spent word; a member's value kept; the retry days, for a
// new lead and not for a request; every way a source fails recorded with its code and the next one
// asked, the run done and the hold released; one run per request key and per new lead, through the
// subscriber; names left out at start; and no value in a history, sources_tried, an event or a log
// line. `pnpm -F worker test:replay` replays the two histories recorded from here. gamma-en-070: a
// lead with only a company's name, its LinkedIn page found by web-search on its fake, then the
// source that needs a page; a web search failing with no adapter left, and the next source asked.
// gamma-en-065: a company with only a domain filled by the website source, from a site this test
// serves on 127.0.0.1, on the LLM fake, stamped `website`; its answer failing the gates twice
// recorded failed, nothing written; no page's path or text in the history, sources_tried or a log.
// gamma-en-060: the `linkedin` source on the LinkedIn fake, through a connected account of the
// workspace, filling only the wanted fields, stamped `linkedin`; with no account, or none with company
// reads left, a skip with no call, and the next source asked.
// gamma-en-075: the source country-ai on the LLM fake, a lead's country named from its location.
// gamma-rf-010: a company read as contacts answers it (getCompany), its facts from the shared
// company's and the organization's layers; a fact one organization's run filled from open data read
// by another organization's workspace, whose run asks no source for it.
// gamma-rf-020: a company's facts older than ENRICHMENT_FACT_DAYS asked again by a new lead's run,
// each renewed on the layer its source's class goes to.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  CompanyDataFake,
  CompanyFacts,
  LinkedinFake,
  LlmFake,
  WebSearchFake,
} from "@whytide/providers";

// The fakes whatever the environment names: the providers' config reads them as it loads, below.
process.env.PROVIDER_COMPANY_DATA = "fake";
process.env.PROVIDER_LLM = "fake";
process.env.PROVIDER_WEB_SEARCH = "fake";
process.env.PROVIDER_BROWSER = "fake";
process.env.PROVIDER_LINKEDIN = "fake";

/** The website source's site, a company's pages under its domain's first label. */
const SITE: Record<string, string> = {
  "/robots.txt": "User-agent: *\nAllow: /\n",
  "/ember/": `<html><head><title>Ember Kilns</title></head><body><h1>Kilns for potters</h1>
    <p>Ember Kilns builds electric kilns for pottery studios and schools.</p>
    <p><a href="/ember/about">About</a></p>
    <footer><a href="https://www.linkedin.com/company/ember-kilns">LinkedIn</a></footer></body></html>`,
  "/ember/about": `<html><head><title>About</title></head><body>
    <p>Our workshop and head office are in Stoke-on-Trent, United Kingdom.</p>
    <p>We are 42 kiln makers.</p></body></html>`,
};
const site = createServer((req, res) => {
  const body = SITE[req.url ?? ""];
  const type = req.url === "/robots.txt" ? "text/plain" : "text/html; charset=utf-8";
  if (body === undefined) res.writeHead(404).end();
  else res.writeHead(200, { "content-type": type }).end(body);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const siteOrigin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
// The platform's egress config reads it as it loads, below.
process.env.EGRESS_ALLOW_HOSTS = new URL(siteOrigin).host;
after(() => {
  site.closeAllConnections();
  site.close();
});

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const {
  companyDataPort,
  createFake,
  defineAdapter,
  getAdapter,
  linkedinPort,
  llmPort,
  webSearchPort,
} = await import("@whytide/providers");
const { loadAgentTasks } = await import("@whytide/ai");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { start } = await import("../src/start.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");

// The modules by their builds' paths, as the loader imports them.
const built = (file: string) => import(new URL(`../../../modules/${file}`, import.meta.url).href);
type Contacts = typeof import("../../../modules/contacts/dist/index.js");
type ContactsTesting = typeof import("../../../modules/contacts/dist/testing/index.js");
type Enrichment = typeof import("../../../modules/enrichment/dist/index.js");
type EnrichmentTesting = typeof import("../../../modules/enrichment/dist/testing/index.js");
type EnrichmentEvents = typeof import("../../../modules/enrichment/dist/events.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type SourceInput = import("../../../modules/enrichment/dist/index.js").SourceInput;
const contacts: Contacts = await built("contacts/dist/index.js");
const { useEnrichmentHold, useHashSalt }: ContactsTesting = await built(
  "contacts/dist/testing/index.js",
);
const enrichment: Enrichment = await built("enrichment/dist/index.js");
const {
  createRun,
  useAgentCall,
  useClock,
  useEnrichmentClient,
  useSiteHome,
  useSourceLists,
}: EnrichmentTesting = await built("enrichment/dist/testing/index.js");
const { runStart }: EnrichmentEvents = await built("enrichment/dist/events.js");
const { createOrganizationWithWorkspace, useTenancyClient }: TenancyTesting = await built(
  "tenancy/dist/testing/index.js",
);

const linkedinTesting: LinkedinTesting = await built("linkedin/dist/testing/index.js");
// The worker's decrypt entry for readCompany, registered as the worker registers it on loading.
await built("linkedin/dist/workflows/index.js");

withTestDb();
const env = withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
// Every new lead is held, as in production: what the batch reads.
useEnrichmentHold(60);
useEnrichmentClient(app);
useTenancyClient(app);
// The website source's agent, loaded from the sources as the host loads it, calling as `app`.
const READ_SITE = "../../../modules/enrichment/agents/read-company-site/task.ts";
await loadAgentTasks([new URL(READ_SITE, import.meta.url).href]);
const llm = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const prices = { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } };
useAgentCall({ client: app, prices: { version: "test", prices } });
useSiteHome((domain) => new URL(`${siteOrigin}/${domain.split(".")[0]}/`));
const NOW = new Date("2026-11-13T10:00:00Z");
const DAY_MS = 86_400_000;
let clock = NOW;
useClock(() => clock);
linkedinTesting.useClock(() => clock);
linkedinTesting.useLinkedinClient(app);
linkedinTesting.useSecretKeys(platform.loadMasterKeys({ APP_MASTER_KEY: platform.newMasterKey() }));
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
const modules = moduleLoaders.filter(({ name }) => name === "enrichment");
const loaded = await loadModules(modules);
// As the host does before it polls: the module's warnings go to this file's log.
for (const { onWorkerStart } of loaded.starts) await onWorkerStart({ log });
// The country namer from its sources (gamma-en-075), calling as `app` like the website's agent.
await loadAgentTasks([
  new URL("../../../modules/enrichment/agents/name-country/task.ts", import.meta.url).href,
]);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => [
    name,
    hostActivity(name, definition, { client: app, log }),
  ]),
);
const fake = (await getAdapter(companyDataPort, "fake")) as unknown as CompanyDataFake;
const webFake = (await getAdapter(webSearchPort, "fake")) as unknown as WebSearchFake;
const linkedinFake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const FAKE = "company-data/fake";
const SECOND = "company-data/second";

/** A second company-data adapter, open data: companies seeded under a key, as the fake's. */
const second = createFake(companyDataPort, {
  state: () => ({ companies: new Map<string, CompanyFacts>() }),
  methods: (self) => ({
    lookupCompany: async ({ linkedinUrl, domain, name }) => {
      for (const key of [linkedinUrl, domain, name]) {
        const facts = key === undefined ? undefined : self.state.companies.get(key.toLowerCase());
        if (facts) return { result: "found" as const, company: structuredClone(facts) };
      }
      return { result: "not_found" as const };
    },
  }),
  helpers: (self) => ({
    seedCompany: (key: string, facts: CompanyFacts): void => {
      self.state.companies.set(key.toLowerCase(), facts);
    },
  }),
});
defineAdapter(companyDataPort, { name: "second", openData: true, create: () => second });

/** The inputs each source defined here got, by its name. */
const asked = new Map<string, SourceInput[]>();
const record = (name: string, input: SourceInput) =>
  void asked.set(name, [...(asked.get(name) ?? []), input]);
// A company source that needs a domain: it runs once the pass has one.
enrichment.defineSource({
  name: "test-by-domain",
  kind: "company",
  fills: ["industry"],
  needs: ["domain"],
  activityKind: "db",
  provenance: { source: "web_search", provider: "test-by-domain" },
  run: async (input) => {
    record("test-by-domain", input);
    return { found: true, facts: { industry: "Maritime software" } };
  },
});
// A company source that needs a LinkedIn page, as the `linkedin` source does (gamma-en-060).
enrichment.defineSource({
  name: "test-by-page",
  kind: "company",
  fills: ["industry"],
  needs: ["linkedinUrl"],
  activityKind: "db",
  provenance: { source: "linkedin", provider: "test-by-page" },
  run: async (input) => {
    record("test-by-page", input);
    return { found: true, facts: { industry: "Maritime software" } };
  },
});
// An `ai` source with a one-second timeout that answers after three.
enrichment.defineSource({
  name: "test-slow",
  kind: "company",
  fills: ["description"],
  needs: ["name", "domain"],
  activityKind: "ai",
  timeoutSeconds: 1,
  provenance: { source: "ai_inferred", provider: "test-slow" },
  run: async (input) => {
    record("test-slow", input);
    await sleep(3_000);
    return { found: false };
  },
});

const principal = platform.servicePrincipal("enrichment_test");
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });
const newWorkspace = () => `wsp_${randomUUID().replaceAll("-", "")}`;
const imported = { source: "import", provider: "csv" } as const;
const BLUE = { name: "Blue Harbor Labs", domain: "blueharbor.example" };
const BLUE_PAGE = "https://www.linkedin.com/company/blue-harbor";
const BLUE_FACTS: CompanyFacts = {
  name: "Blue Harbor Labs Ltd",
  linkedinUrl: BLUE_PAGE,
  industry: "Maritime software",
  employeeRange: { from: 51, to: 200 },
  employeeCount: 120,
  country: "GB",
  description: "Charts for harbours.",
  foundedYear: 2001,
};
/** What no history, sources_tried, event or log line may hold: the leads' and companies' values. */
const VALUES = [
  "blueharbor",
  "Blue Harbor",
  "blue-harbor",
  "Maritime",
  "Charts for harbours",
  "Copper Harbor",
  "copper-harbor",
  "Noor",
  "Haddad",
  "Head of Sales",
  "Berlin",
  ".example",
];

/** A held lead imported at `company`, made and linked; with a company's name only, none. */
function leadAt(
  workspaceId: string,
  slug: string,
  company: { name: string; domain: string } | { companyName: string },
): Promise<string> {
  return inRun(workspaceId, async () => {
    const companyName = "name" in company ? company.name : company.companyName;
    const profile = {
      linkedinUrl: `https://linkedin.com/in/${slug}`,
      firstName: "Noor",
      lastName: "Haddad",
      title: "Head of Sales",
      companyName,
      locationText: "Berlin, Germany",
    };
    const { person } = await contacts.upsertPersonFromSource({ ...imported, profile });
    if ("name" in company) {
      const { company: stored } = await contacts.upsertCompany({ ...imported, company });
      await contacts.linkPersonToCompany({ personId: person.id, companyId: stored.id });
    }
    const source = { kind: "imported", ref: "imp_1" } as const;
    await contacts.createLeadForPerson({ personId: person.id, source });
    return person.id;
  });
}

type RunResult = { filled: string[]; failed: boolean };
const runRow = (id: string) => app.enrichmentRun.findUniqueOrThrow({ where: { id } });
/** A run of the person, by the batch's key or a request's, run to its end on the slice's Temporal. */
async function enrich(
  workspaceId: string,
  personId: string,
  options: { trigger?: "new_lead" | "request"; workflowId?: string } = {},
) {
  const { trigger = "new_lead", workflowId } = options;
  const requestKey = trigger === "new_lead" ? `new_lead:${personId}` : `request:${randomUUID()}`;
  const { runId } = await inRun(workspaceId, () => createRun({ personId, trigger, requestKey }));
  const input = { workspaceId, runId };
  const result = await runWorkflow<RunResult>("enrichment_run", input, {
    activities,
    ...(workflowId !== undefined && { workflowId }),
  });
  return { runId, result, run: await runRow(runId) };
}
type Tried = { source: string; outcome: string; code: string | null; filled: string[] };
/** sources_tried without the durations, each checked a number. */
const tried = (stored: unknown): Tried[] =>
  (stored as (Tried & { ms: unknown })[]).map(({ ms, ...entry }) => {
    assert.equal(typeof ms, "number");
    return entry;
  });
/** The person's company as contacts answers it: its facts from the layers (gamma-rf-010). */
const companyOf = async (personId: string) => {
  const { workspaceId, companyId } = await app.person.findUniqueOrThrow({
    where: { id: personId },
  });
  return companyId === null ? null : inRun(workspaceId, () => contacts.getCompany(companyId));
};
const holdOf = async (personId: string) =>
  (await app.lead.findUniqueOrThrow({ where: { personId } })).enrichmentHoldUntil;
const usage = () =>
  app.sourceUsage.findMany({
    select: { source: true, periodStart: true, used: true, spent: true },
    orderBy: [{ source: "asc" }, { periodStart: "asc" }],
  });
/** The workflow's history as text, its payloads decoded. */
async function historyOf(workflowId: string): Promise<string> {
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  return JSON.stringify(history).replaceAll(/"data":"([\w+/=]+)"/g, (_, data: string) =>
    Buffer.from(data, "base64").toString("utf8"),
  );
}
const holdsNoValue = (text: string, what: string) => {
  for (const value of VALUES) assert.ok(!text.includes(value), `${what} holds "${value}"`);
};
/** What `read` answers once it answers something, within thirty seconds. */
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, "until: nothing within thirty seconds");
    await sleep(50);
  }
}
/** The worker host on a queue of its own, with the schedules paused, around `fn`. */
async function withHost(fn: (taskQueue: string) => Promise<void>): Promise<void> {
  const taskQueue = `test-${randomUUID()}`;
  const options = { modules, taskQueue, healthPort: 0, schedules: "off", alerts: "" } as const;
  const host = await start({ ...options, client: app, log });
  try {
    await fn(taskQueue);
  } finally {
    await host.close();
    await env.client.schedule
      .getHandle("enrichment.tick")
      .delete()
      .catch(() => undefined);
  }
}

beforeEach(() => {
  fake.reset();
  second.reset();
  webFake.reset();
  linkedinFake.reset();
  linkedinTesting.useCompanyReadShare(undefined);
  llm.reset();
  asked.clear();
  clock = NOW;
  useSourceLists(undefined);
  logs.raw.length = 0;
});

test("the tick, through the host, starts the batch of each workspace with a held lead, which runs the lead's new_lead run as a child: the company's empty fields filled with the adapter's class and name at the run's time, the hold released; the schedule every five minutes, overlap skip", async () => {
  const { workspace } = await createOrganizationWithWorkspace();
  await createOrganizationWithWorkspace();
  const workspaceId = workspace.id;
  const personId = await leadAt(workspaceId, "tick-lead", BLUE);
  fake.seedCompany(BLUE.domain, BLUE_FACTS);
  assert.ok(await holdOf(personId));
  await withHost(async (taskQueue) => {
    const tick = await env.client.workflow.execute("enrichment_tick", {
      args: [{}],
      taskQueue,
      workflowId: `enrichment_tick-${randomUUID()}`,
      workflowExecutionTimeout: "1 minute",
    });
    assert.deepEqual(tick, { workspaces: 2, started: 1 });
    const batch = env.client.workflow.getHandle(`enrichment.batch:${workspaceId}`);
    assert.deepEqual(await batch.result(), { leads: 1, runs: 1, failed: 0 });
    const schedule = await env.client.schedule.getHandle("enrichment.tick").describe();
    assert.equal(schedule.action.workflowType, "enrichment_tick");
    const every = schedule.spec.intervals?.map(({ every }) => every);
    assert.deepEqual([every, schedule.policies.overlap], [[300_000], "SKIP"]);
  });
  const company = (await companyOf(personId)) ?? assert.fail("no company");
  const { name, domain, linkedinUrl, industry, sizeRange, employeeCount, country, description } =
    company;
  assert.deepEqual(
    { name, domain, linkedinUrl, industry, sizeRange, employeeCount, country, description },
    {
      ...BLUE,
      linkedinUrl: "https://linkedin.com/company/blue-harbor",
      industry: "Maritime software",
      sizeRange: "51-200",
      employeeCount: 120,
      country: "GB",
      description: "Charts for harbours.",
    },
  );
  const stamp = { source: "data_vendor", provider: "fake", at: NOW.toISOString() };
  const provenance = company.fieldProvenance as Record<string, unknown>;
  for (const field of ["linkedinUrl", "industry", "sizeRange", "country", "description"]) {
    assert.deepEqual(provenance[field], stamp, field);
  }
  assert.equal(await holdOf(personId), null);
  const [run, ...more] = await app.enrichmentRun.findMany({ where: { personId } });
  assert.equal(more.length, 0);
  assert.deepEqual(
    [run?.trigger, run?.requestKey, run?.status, run?.skipReason, run?.companyId],
    ["new_lead", `new_lead:${personId}`, "done", null, company.id],
  );
  assert.deepEqual(run?.filled, ["linkedinUrl", "industry", "sizeRange", "country", "description"]);
  assert.deepEqual(
    [run?.createdAt, run?.startedAt, run?.finishedAt].map((at) => at?.toISOString()),
    [NOW.toISOString(), NOW.toISOString(), NOW.toISOString()],
  );
});

test("two adapters in PROVIDER_COMPANY_DATA's order: the first fills the size, the second is asked only for what is still empty and its other facts are not written; a company the first fills whole never reaches the second; no value in the run's history, sources_tried or a log line", async (t) => {
  useSourceLists({ companyData: ["fake", "second"] });
  const workspaceId = newWorkspace();
  fake.seedCompany(BLUE.domain, { employeeRange: { from: 51, to: 200 }, employeeCount: 120 });
  const { name: _name, ...rest } = BLUE_FACTS;
  second.seedCompany(BLUE.domain, {
    ...rest,
    employeeRange: { from: 1001, to: 5000 },
    employeeCount: 4200,
  });
  const personId = await leadAt(workspaceId, "two-adapters", BLUE);
  const workflowId = `enrichment_run-${randomUUID()}`;
  const { run, result } = await enrich(workspaceId, personId, { workflowId });
  t.diagnostic(`history: ${workflowId}`);
  const filled = ["sizeRange", "linkedinUrl", "industry", "country", "description"];
  assert.deepEqual(result, { filled, failed: false });
  assert.deepEqual(tried(run.sourcesTried), [
    { source: FAKE, outcome: "found", code: null, filled: ["sizeRange"] },
    {
      source: SECOND,
      outcome: "found",
      code: null,
      filled: ["linkedinUrl", "industry", "country", "description"],
    },
  ]);
  assert.deepEqual(run.wanted, ["linkedinUrl", "industry", "sizeRange", "country", "description"]);
  const company = (await companyOf(personId)) ?? assert.fail("no company");
  assert.deepEqual([company.sizeRange, company.employeeCount], ["51-200", 120]);
  const provenance = company.fieldProvenance as Record<
    string,
    { source: string; provider: string }
  >;
  const classes = ["sizeRange", "industry"].map((field) => provenance[field]?.provider);
  assert.deepEqual(classes, ["fake", "second"]);
  assert.equal(provenance.industry?.source, "open_data");

  const green = { name: "Green Quay", domain: "greenquay.example" };
  fake.seedCompany(green.domain, { ...rest, linkedinUrl: "https://www.linkedin.com/company/gq" });
  const whole = await enrich(workspaceId, await leadAt(workspaceId, "first-fills", green));
  assert.deepEqual(
    tried(whole.run.sourcesTried).map(({ source }) => source),
    [FAKE],
  );
  assert.equal(second.recordedCalls.length, 1);

  holdsNoValue(await historyOf(workflowId), "the run's history");
  holdsNoValue(JSON.stringify(run.sourcesTried), "sources_tried");
  holdsNoValue(logs.raw.join("\n"), "the log");
});

test("a fact one organization's run filled from open data is shared: another organization's workspace reads it with its provenance, and its run asks no source for it (gamma-rf-010)", async () => {
  useSourceLists({ companyData: ["second"] });
  const [{ workspace: a }, { workspace: b }] = [
    await createOrganizationWithWorkspace(),
    await createOrganizationWithWorkspace(),
  ];
  const { name: _name, ...rest } = BLUE_FACTS;
  second.seedCompany(BLUE.domain, rest);
  const first = await enrich(a.id, await leadAt(a.id, "shared-first", BLUE));
  const fields = ["linkedinUrl", "industry", "sizeRange", "country", "description"];
  assert.deepEqual(first.result, { filled: fields, failed: false });
  assert.equal(second.recordedCalls.length, 1);
  const personId = await leadAt(b.id, "shared-second", BLUE);
  const theirs = (await companyOf(personId)) ?? assert.fail("no company");
  const openData = { source: "open_data", provider: "second", at: NOW.toISOString() };
  assert.deepEqual(
    [theirs.industry, theirs.fieldProvenance.industry],
    ["Maritime software", openData],
  );
  const { run, result } = await enrich(b.id, personId);
  assert.deepEqual(
    [result, run.wanted, tried(run.sourcesTried)],
    [{ filled: [], failed: false }, [], []],
  );
  assert.equal(second.recordedCalls.length, 1, "no source asked for a shared fact");
  const read = (await companyOf(personId)) ?? assert.fail("no company");
  assert.equal(
    read.linkedinUrl,
    "https://linkedin.com/company/blue-harbor",
    "the page, copied down",
  );
});

test("a company's facts older than ENRICHMENT_FACT_DAYS are asked again by a new lead's run, its keys are not: each source's value and stamp replace the old ones on the layer its class goes to, open data's on the shared company, a data vendor's on the organization's row (gamma-rf-020)", async () => {
  useSourceLists({ company: ["company-data"], companyData: ["second"] });
  const { workspace } = await createOrganizationWithWorkspace();
  const { name: _name, ...rest } = BLUE_FACTS;
  second.seedCompany(BLUE.domain, rest);
  const old = new Date(NOW.getTime() - 181 * DAY_MS);
  clock = old;
  const first = await enrich(workspace.id, await leadAt(workspace.id, "old-facts-1", BLUE));
  const facts = ["industry", "sizeRange", "country", "description"];
  assert.deepEqual(first.result, { filled: ["linkedinUrl", ...facts], failed: false });

  clock = NOW;
  useSourceLists({ company: ["company-data"], companyData: ["fake", "second"] });
  fake.seedCompany(BLUE.domain, { industry: "Marine charts" });
  second.seedCompany(BLUE.domain, {
    ...rest,
    industry: "Not asked",
    employeeRange: { from: 201, to: 500 },
    employeeCount: 300,
    country: "IE",
    description: "Charts for every harbour.",
  });
  const personId = await leadAt(workspace.id, "old-facts-2", BLUE);
  const { run, result } = await enrich(workspace.id, personId);
  assert.deepEqual([run.trigger, run.wanted], ["new_lead", facts]);
  assert.deepEqual(result, { filled: facts, failed: false });
  assert.deepEqual(tried(run.sourcesTried), [
    { source: FAKE, outcome: "found", code: null, filled: ["industry"] },
    {
      source: SECOND,
      outcome: "found",
      code: null,
      filled: ["sizeRange", "country", "description"],
    },
  ]);
  const company = (await companyOf(personId)) ?? assert.fail("no company");
  const { industry, sizeRange, employeeCount, country, description } = company;
  assert.deepEqual(
    { industry, sizeRange, employeeCount, country, description },
    {
      industry: "Marine charts",
      sizeRange: "201-500",
      employeeCount: 300,
      country: "IE",
      description: "Charts for every harbour.",
    },
  );
  const vendor = { source: "data_vendor", provider: "fake", at: NOW.toISOString() };
  const openData = { source: "open_data", provider: "second", at: NOW.toISOString() };
  const stamps = company.fieldProvenance as Record<string, unknown>;
  assert.deepEqual(
    facts.map((field) => stamps[field]),
    [vendor, openData, openData, openData],
  );
  // The vendor's industry on the organization's row; open data's facts on the shared company, whose
  // old industry stays there with its stamp, read by no workspace of this organization.
  const row = await app.workspaceCompany.findFirstOrThrow({
    where: { workspaceId: workspace.id, domain: BLUE.domain },
  });
  const companyId = row.companyId ?? assert.fail("no link");
  const shared = await app.sharedCompany.findUniqueOrThrow({ where: { id: companyId } });
  const group = await app.groupCompany.findFirstOrThrow({ where: { companyId } });
  const sharedStamps = shared.fieldProvenance as Record<string, unknown>;
  const oldOpenData = { ...openData, at: old.toISOString() };
  assert.deepEqual(
    [shared.industry, sharedStamps.industry, shared.country, sharedStamps.country],
    ["Maritime software", oldOpenData, "IE", openData],
  );
  const groupStamps = group.fieldProvenance as Record<string, unknown>;
  assert.deepEqual([group.industry, groupStamps.industry], ["Marine charts", vendor]);
});

test("a source that adds a domain restarts the pass: the earlier source that needs one runs then, once, with the minimum input; a person with only a company's name gets the company of the domain a source answered and a link; facts with no page or domain write nothing", async () => {
  useSourceLists({ company: ["test-by-domain", "company-data"], companyData: ["fake"] });
  const workspaceId = newWorkspace();
  const copper = "Copper Harbor Labs";
  fake.seedCompany(copper, {
    name: copper,
    domain: "copper-harbor.example",
    employeeRange: { from: 11, to: 50 },
  });
  const personId = await leadAt(workspaceId, "name-only", { companyName: copper });
  const { run, result } = await enrich(workspaceId, personId);
  assert.deepEqual(result, { filled: ["domain", "sizeRange", "industry"], failed: false });
  assert.deepEqual(tried(run.sourcesTried), [
    { source: FAKE, outcome: "found", code: null, filled: ["domain", "sizeRange"] },
    { source: "test-by-domain", outcome: "found", code: null, filled: ["industry"] },
  ]);
  assert.deepEqual(
    fake.recordedCalls.map(({ input }) => input),
    [{ name: copper }],
  );
  const company = (await companyOf(personId)) ?? assert.fail("no company made");
  // The minimum input with the run's ids: the company the earlier source made, by its id.
  assert.deepEqual(asked.get("test-by-domain"), [
    {
      workspaceId,
      companyId: company.id,
      company: { domain: "copper-harbor.example", name: copper },
      wanted: ["industry"],
    },
  ]);
  assert.deepEqual(
    [company.name, company.domain, company.sizeRange, company.industry, run.companyId],
    [copper, "copper-harbor.example", "11-50", "Maritime software", company.id],
  );
  const provenance = company.fieldProvenance as Record<string, { source: string; at: string }>;
  assert.deepEqual(
    ["name", "domain", "industry"].map((field) => provenance[field]?.source),
    ["data_vendor", "data_vendor", "web_search"],
  );
  assert.equal(provenance.domain?.at, NOW.toISOString());

  fake.seedCompany("Nameless Ltd", { industry: "Retail" });
  const nameless = await leadAt(workspaceId, "nameless", { companyName: "Nameless Ltd" });
  const none = await enrich(workspaceId, nameless);
  assert.deepEqual(tried(none.run.sourcesTried), [
    { source: FAKE, outcome: "no_company_key", code: null, filled: [] },
  ]);
  assert.equal(await companyOf(nameless), null);
  assert.equal(await app.workspaceCompany.count({ where: { workspaceId } }), 1);
  assert.equal(asked.get("test-by-domain")?.length, 1);
});

test("the instance's allowance, whichever workspace asks: a source past it is skipped as allowance_spent with no call; a vendor's company_data_allowance_spent marks it spent until its period ends", async () => {
  fake.setAllowance({ calls: 1, per: "day" });
  fake.seedCompany(BLUE.domain, { industry: "Maritime software" });
  const [a, b] = [newWorkspace(), newWorkspace()];
  const inA = await enrich(a, await leadAt(a, "allowance-a", BLUE));
  const inB = await enrich(b, await leadAt(b, "allowance-b", BLUE));
  assert.deepEqual(tried(inA.run.sourcesTried), [
    { source: FAKE, outcome: "found", code: null, filled: ["industry"] },
  ]);
  assert.deepEqual(tried(inB.run.sourcesTried), [
    { source: FAKE, outcome: "allowance_spent", code: null, filled: [] },
  ]);
  assert.deepEqual([inB.run.status, inB.result.failed], ["done", false]);
  assert.equal(fake.recordedCalls.length, 1);
  assert.deepEqual(await usage(), [
    { source: FAKE, periodStart: "2026-11-13", used: 1, spent: false },
  ]);

  // The next day, with calls left, the vendor says they are gone: none until the day ends.
  fake.setAllowance({ calls: 100, per: "day" });
  clock = new Date(NOW.getTime() + DAY_MS);
  fake.failNext("company_data_allowance_spent");
  const quay = (n: number) => ({ name: `Quay ${n}`, domain: `quay-${n}.example` });
  const spent = await enrich(b, await leadAt(b, "allowance-c", quay(1)));
  assert.deepEqual(tried(spent.run.sourcesTried), [
    { source: FAKE, outcome: "allowance_spent", code: "company_data_allowance_spent", filled: [] },
  ]);
  const later = await enrich(a, await leadAt(a, "allowance-d", quay(2)));
  assert.deepEqual(tried(later.run.sourcesTried), [
    { source: FAKE, outcome: "allowance_spent", code: null, filled: [] },
  ]);
  assert.equal(fake.recordedCalls.length, 2);
  clock = new Date(NOW.getTime() + 2 * DAY_MS);
  const again = await enrich(a, await leadAt(a, "allowance-e", quay(3)));
  assert.deepEqual(
    tried(again.run.sourcesTried).map(({ outcome }) => outcome),
    ["not_found"],
  );
  assert.deepEqual(await usage(), [
    { source: FAKE, periodStart: "2026-11-13", used: 1, spent: false },
    { source: FAKE, periodStart: "2026-11-14", used: 1, spent: true },
    { source: FAKE, periodStart: "2026-11-15", used: 1, spent: false },
  ]);
});

test("a member's value is never changed: a field a member set or cleared is not wanted, and the source's facts for it are not written", async () => {
  const workspaceId = newWorkspace();
  const personId = await leadAt(workspaceId, "member-values", BLUE);
  const stored = (await companyOf(personId)) ?? assert.fail("no company");
  const member = { source: "member", provider: null, at: "2026-11-01T00:00:00.000Z" };
  const fieldProvenance = {
    ...(stored.fieldProvenance as object),
    industry: member,
    description: member,
  };
  await app.workspaceCompany.update({
    where: { id: stored.id },
    data: { industry: "Hand-set industry", fieldProvenance },
  });
  fake.seedCompany(BLUE.domain, BLUE_FACTS);
  const { run } = await enrich(workspaceId, personId);
  assert.deepEqual(run.wanted, ["linkedinUrl", "sizeRange", "country"]);
  assert.deepEqual(run.filled, ["linkedinUrl", "sizeRange", "country"]);
  const company = (await companyOf(personId)) ?? assert.fail("no company");
  assert.deepEqual([company.industry, company.description], ["Hand-set industry", null]);
  const provenance = company.fieldProvenance as Record<string, unknown>;
  assert.deepEqual([provenance.industry, provenance.description], [member, member]);
});

test("a company a run tried within ENRICHMENT_COMPANY_RETRY_DAYS is not asked again for a new lead, which is released at once, but is for a request; past the days, a new lead asks again", async () => {
  const workspaceId = newWorkspace();
  fake.seedCompany(BLUE.domain, { employeeRange: { from: 51, to: 200 } });
  const first = await enrich(workspaceId, await leadAt(workspaceId, "retry-1", BLUE));
  assert.deepEqual(first.run.filled, ["sizeRange"]);
  clock = new Date(NOW.getTime() + 29 * DAY_MS);
  const nextId = await leadAt(workspaceId, "retry-2", BLUE);
  const next = await enrich(workspaceId, nextId);
  assert.deepEqual(
    [next.run.status, next.run.skipReason, next.run.wanted, tried(next.run.sourcesTried)],
    ["done", "enriched_recently", [], []],
  );
  assert.equal(await holdOf(nextId), null);
  assert.equal(fake.recordedCalls.length, 1);
  const requested = await enrich(workspaceId, nextId, { trigger: "request" });
  assert.deepEqual([requested.run.trigger, requested.run.skipReason], ["request", null]);
  assert.equal(fake.recordedCalls.length, 2);
  // 31 days after the request's run.
  clock = new Date(NOW.getTime() + 60 * DAY_MS);
  const past = await enrich(workspaceId, await leadAt(workspaceId, "retry-3", BLUE));
  assert.equal(past.run.skipReason, null);
  assert.equal(fake.recordedCalls.length, 3);
});

test("a source failing for any reason, its key refused, a rate limit, an adapter's bug, its free calls gone, a timeout, is recorded with its outcome and code, asked once, never retried, with one warning and no value, and the next source is asked in the same pass", async () => {
  useSourceLists({ companyData: ["fake", "second"] });
  const workspaceId = newWorkspace();
  const cases = [
    ["unauthorized", () => fake.failNext("company_data_unauthorized"), "failed"],
    ["rate_limited", () => fake.failNext("company_data_rate_limited"), "failed"],
    ["bug", () => fake.answerNext("lookupCompany", new Error("bug")), "failed"],
    // Last: the vendor's word spends the source for the rest of the day.
    ["allowance_spent", () => fake.failNext("company_data_allowance_spent"), "allowance_spent"],
  ] as const;
  const codes = {
    unauthorized: "company_data_unauthorized",
    rate_limited: "company_data_rate_limited",
    bug: "company_data_error_unmapped",
    allowance_spent: "company_data_allowance_spent",
  } as const;
  for (const [slug, fail, outcome] of cases) {
    const company = { name: `Fails ${slug}`, domain: `${slug.replaceAll("_", "-")}.example` };
    second.seedCompany(company.domain, { industry: "Maritime software" });
    const personId = await leadAt(workspaceId, `fails-${slug.replaceAll("_", "-")}`, company);
    fake.reset();
    fail();
    const { run, result } = await enrich(workspaceId, personId);
    assert.deepEqual([run.status, result], ["done", { filled: ["industry"], failed: false }], slug);
    assert.deepEqual(
      tried(run.sourcesTried),
      [
        { source: FAKE, outcome, code: codes[slug], filled: [] },
        { source: SECOND, outcome: "found", code: null, filled: ["industry"] },
      ],
      slug,
    );
    assert.equal(fake.recordedCalls.length, 1, `${slug}: asked once`);
    assert.equal(await holdOf(personId), null, slug);
  }
  const warned = logs
    .lines()
    .filter(({ msg }) => msg === "enrichment: a source failed; the next one is asked");
  assert.deepEqual(
    warned.map(({ level, provider, code }) => [level, provider, code]),
    ["unauthorized", "rate_limited", "bug"].map((slug) => [
      "warn",
      FAKE,
      codes[slug as keyof typeof codes],
    ]),
  );

  useSourceLists({ company: ["test-slow", "company-data"], companyData: ["second"] });
  const slow = { name: "Slow Quay", domain: "slow-quay.example" };
  second.seedCompany(slow.domain, { industry: "Maritime software" });
  const slowId = await leadAt(workspaceId, "fails-slow", slow);
  const timedOut = await enrich(workspaceId, slowId);
  assert.deepEqual(tried(timedOut.run.sourcesTried), [
    { source: "test-slow", outcome: "failed", code: "activity_timeout", filled: [] },
    { source: SECOND, outcome: "found", code: null, filled: ["industry"] },
  ]);
  const slowCompany = (await companyOf(slowId)) ?? assert.fail("no company");
  assert.deepEqual(asked.get("test-slow"), [
    {
      workspaceId,
      companyId: slowCompany.id,
      company: { domain: "slow-quay.example", name: "Slow Quay" },
      wanted: ["description"],
    },
  ]);
  holdsNoValue(logs.raw.join("\n"), "the log");
});

test("every source failing ends the run done with each failure recorded and releases the hold; the company's next new lead asks again", async () => {
  const workspaceId = newWorkspace();
  const firstId = await leadAt(workspaceId, "failing-1", BLUE);
  fake.failNext("company_data_unauthorized");
  const first = await enrich(workspaceId, firstId);
  assert.deepEqual([first.run.status, first.result], ["done", { filled: [], failed: false }]);
  assert.deepEqual(tried(first.run.sourcesTried), [
    { source: FAKE, outcome: "failed", code: "company_data_unauthorized", filled: [] },
  ]);
  assert.equal(await holdOf(firstId), null);
  fake.seedCompany(BLUE.domain, { industry: "Maritime software" });
  const next = await enrich(workspaceId, await leadAt(workspaceId, "failing-2", BLUE));
  assert.deepEqual(
    [next.run.skipReason, tried(next.run.sourcesTried).map(({ outcome }) => outcome)],
    [null, ["found"]],
  );
  assert.equal(fake.recordedCalls.length, 2);
});

test("the batch: the workspace's held leads, oldest first, each with its new_lead run as a child; a lead whose key has its run gets none and is released", async (t) => {
  const workspaceId = newWorkspace();
  fake.seedCompany(BLUE.domain, { industry: "Maritime software" });
  const first = await leadAt(workspaceId, "batch-1", BLUE);
  const next = await leadAt(workspaceId, "batch-2", { companyName: "Copper Harbor Labs" });
  const workflowId = `enrichment_batch-${randomUUID()}`;
  const counts = await runWorkflow("enrichment_batch", { workspaceId }, { activities, workflowId });
  t.diagnostic(`history: ${workflowId}`);
  assert.deepEqual(counts, { leads: 2, runs: 2, failed: 0 });
  const runs = await app.enrichmentRun.findMany({ where: { workspaceId }, orderBy: { id: "asc" } });
  assert.deepEqual(
    runs.map(({ personId, trigger, status }) => [personId, trigger, status]),
    [
      [first, "new_lead", "done"],
      [next, "new_lead", "done"],
    ],
  );
  for (const personId of [first, next]) assert.equal(await holdOf(personId), null);

  await app.lead.update({
    where: { personId: first },
    data: { enrichmentHoldUntil: new Date(Date.now() + 3_600_000) },
  });
  const again = await runWorkflow("enrichment_batch", { workspaceId }, { activities });
  assert.deepEqual(again, { leads: 1, runs: 0, failed: 0 });
  assert.equal(await holdOf(first), null);
  assert.equal(await app.enrichmentRun.count({ where: { personId: first } }), 1);
  holdsNoValue(await historyOf(workflowId), "the batch's history");
});

test("through the host: names that cannot run are left out at start, one warning per list, and the worker runs the others; a request writes one run and one enrichment.run_requested with its id only, whose subscriber starts enrichment.run:<workspace>:<run> once; the same key again makes none, and a redelivery starts none", async () => {
  useSourceLists({ company: ["company-data", "nowhere"], companyData: ["nope", "fake"] });
  const workspaceId = newWorkspace();
  fake.seedCompany(BLUE.domain, { industry: "Maritime software" });
  const personId = await leadAt(workspaceId, "requested", BLUE);
  const request = () =>
    inRun(workspaceId, () =>
      enrichment.requestEnrichment({ personId, requestKey: "panel-click-1" }),
    );
  let runId = "";
  await withHost(async () => {
    const warned = logs
      .lines()
      .filter(
        ({ msg }) => msg === "enrichment: names left out of the list; the worker runs the others",
      );
    assert.deepEqual(
      warned.map(({ level, variable, details }) => [level, variable, details]),
      [
        ["warn", "PROVIDER_COMPANY_DATA", [{ provider: "nope", reason: "provider_unknown" }]],
        ["warn", "ENRICHMENT_COMPANY_SOURCES", [{ provider: "nowhere", reason: "source_unknown" }]],
      ],
    );
    const first = await request();
    const again = await request();
    runId = first.runId;
    assert.deepEqual([first.created, again.created, again.runId], [true, false, runId]);
    const events = await app.outboxEntry.findMany({ where: { workspaceId } });
    const requested = events.filter(({ eventName }) => eventName === "enrichment.run_requested");
    assert.deepEqual(
      requested.map(({ payload }) => payload),
      [{ runId }],
    );
    const handle = env.client.workflow.getHandle(`enrichment.run:${workspaceId}:${runId}`);
    await until(async () => {
      const described = await handle.describe().catch(() => undefined);
      return described?.status.name === "COMPLETED" ? described : undefined;
    });
    assert.deepEqual(await handle.result(), { filled: ["industry"], failed: false });
    assert.deepEqual(await platform.startWorkflow(runStart(workspaceId, runId)), {
      started: false,
    });
  });
  const run = await runRow(runId);
  assert.deepEqual(
    [run.trigger, run.requestKey, run.status, tried(run.sourcesTried).map(({ source }) => source)],
    ["request", "request:panel-click-1", "done", [FAKE]],
  );
  assert.equal(await app.enrichmentRun.count({ where: { personId } }), 1);
  assert.equal(await holdOf(personId), null);
});

test("a lead with only a company's name: web-search finds its LinkedIn page on the fake, the person gets a company record and a link, and the source that needs a page then runs once; the facts stamped web_search with the adapter's name; two searches, the name and fixed words only, each counted; no name, query or link in the history, sources_tried or a log line", async (t) => {
  useSourceLists({ company: ["test-by-page", "web-search"] });
  const workspaceId = newWorkspace();
  const name = "Copper Harbor Labs";
  const page = { url: "https://www.linkedin.com/company/copper-harbor", snippet: "Charts." };
  webFake.seedResults(`"${name}"`, [{ ...page, title: `${name} | LinkedIn` }]);
  const personId = await leadAt(workspaceId, "web-search", { companyName: name });
  const workflowId = `enrichment_run-${randomUUID()}`;
  const { run, result } = await enrich(workspaceId, personId, { workflowId });
  t.diagnostic(`history: ${workflowId}`);
  assert.deepEqual(result, { filled: ["linkedinUrl", "industry"], failed: false });
  assert.deepEqual(tried(run.sourcesTried), [
    { source: "web-search", outcome: "found", code: null, filled: ["linkedinUrl"] },
    { source: "test-by-page", outcome: "found", code: null, filled: ["industry"] },
  ]);
  assert.deepEqual(
    webFake.recordedCalls.map(({ input }) => input),
    [
      { query: `"${name}"`, site: "linkedin.com", count: 5 },
      { query: `"${name}" official website`, count: 5 },
    ],
  );
  const company = (await companyOf(personId)) ?? assert.fail("no company made");
  assert.deepEqual(
    [company.name, company.linkedinUrl, company.domain, run.companyId],
    [name, "https://linkedin.com/company/copper-harbor", null, company.id],
  );
  const provenance = company.fieldProvenance as Record<string, unknown>;
  const stamp = { source: "web_search", provider: "fake", at: NOW.toISOString() };
  assert.deepEqual([provenance.name, provenance.linkedinUrl], [stamp, stamp]);
  assert.deepEqual(asked.get("test-by-page"), [
    {
      workspaceId,
      companyId: company.id,
      company: { linkedinUrl: "https://linkedin.com/company/copper-harbor", name },
      wanted: ["industry"],
    },
  ]);
  const counted = (await usage()).filter(({ source }) => source.startsWith("web-search/"));
  assert.deepEqual(counted, [
    { source: "web-search/fake", periodStart: "2026-11-13", used: 2, spent: false },
  ]);
  const quiet = (text: string, what: string) => {
    holdsNoValue(text, what);
    for (const value of ["official website", "linkedin.com/company"]) {
      assert.ok(!text.includes(value), `${what} holds "${value}"`);
    }
  };
  quiet(await historyOf(workflowId), "the run's history");
  quiet(JSON.stringify(run.sourcesTried), "sources_tried");
  quiet(logs.raw.join("\n"), "the log");
});

test("web-search failing with no adapter left ends failed with the error's code, makes no second search, and the run goes on to the next source; a name that is no company makes no search", async () => {
  useSourceLists({ company: ["web-search", "company-data"], companyData: ["fake"] });
  const workspaceId = newWorkspace();
  const slate = "Slate Quay";
  fake.seedCompany(slate, { name: slate, domain: "slate-quay.example" });
  webFake.failNext("web_search_unauthorized");
  const personId = await leadAt(workspaceId, "web-search-fails", { companyName: slate });
  const { run, result } = await enrich(workspaceId, personId);
  assert.deepEqual([run.status, result], ["done", { filled: ["domain"], failed: false }]);
  assert.deepEqual(tried(run.sourcesTried), [
    { source: "web-search", outcome: "failed", code: "web_search_unauthorized", filled: [] },
    { source: FAKE, outcome: "found", code: null, filled: ["domain"] },
  ]);
  assert.equal(webFake.recordedCalls.length, 1);
  assert.equal(await holdOf(personId), null);

  const selfEmployed = await leadAt(workspaceId, "self-employed", { companyName: "Self-employed" });
  const none = await enrich(workspaceId, selfEmployed);
  assert.deepEqual(tried(none.run.sourcesTried)[0], {
    source: "web-search",
    outcome: "not_a_company",
    code: null,
    filled: [],
  });
  assert.equal(webFake.recordedCalls.length, 1);
  assert.equal(await companyOf(selfEmployed), null);
});

test("a company with only a domain, filled by the website: its pages read, the LinkedIn page from the footer, the AI's facts each quoted from its page, stamped website; an answer that fails the gates twice is recorded failed and writes nothing; no page's path or text in the history, sources_tried or a log line", async (t) => {
  useSourceLists({ company: ["website"] });
  const workspaceId = newWorkspace();
  const ember = { name: "Ember Kilns", domain: "ember.example" };
  const home = `${siteOrigin}/ember/`;
  const about = `${siteOrigin}/ember/about`;
  const none = { industry: null, employeeCount: null, employeeRange: null, country: null };
  llm.script({
    ...none,
    industry: { value: "Kiln making", url: home, quote: "Kilns for potters" },
    employeeCount: { value: 42, url: about, quote: "42 kiln makers" },
    country: { value: "GB", url: about, quote: "Stoke-on-Trent, United Kingdom" },
    description: {
      value: "Ember Kilns builds electric kilns for pottery studios and schools.",
      url: home,
      quote: "builds electric kilns for pottery studios",
    },
  });
  const personId = await leadAt(workspaceId, "website", ember);
  const workflowId = `enrichment_run-${randomUUID()}`;
  const { run, result } = await enrich(workspaceId, personId, { workflowId });
  t.diagnostic(`history: ${workflowId}`);
  const filled = ["linkedinUrl", "industry", "sizeRange", "country", "description"];
  assert.deepEqual(result, { filled, failed: false });
  assert.deepEqual(tried(run.sourcesTried), [
    { source: "website", outcome: "found", code: null, filled },
  ]);
  const company = (await companyOf(personId)) ?? assert.fail("no company");
  assert.deepEqual(
    [company.linkedinUrl, company.industry, company.employeeCount, company.country],
    ["https://linkedin.com/company/ember-kilns", "Kiln making", 42, "GB"],
  );
  const provenance = company.fieldProvenance as Record<string, unknown>;
  const stamp = { source: "website", provider: "website", at: NOW.toISOString() };
  for (const field of filled) assert.deepEqual(provenance[field], stamp, field);
  const records = await app.decisionRecord.findMany({ where: { workspaceId } });
  assert.deepEqual(
    records.map(({ task, subjectRef, status }) => [task, subjectRef, status]),
    [["enrichment.read-company-site", company.id, "ok"]],
  );
  const quiet = (text: string, what: string) => {
    for (const value of [
      "/ember/about",
      "Kiln making",
      "kiln makers",
      "Stoke-on-Trent",
      "Ember",
      "ember.example",
    ]) {
      assert.ok(!text.includes(value), `${what} holds "${value}"`);
    }
  };
  quiet(await historyOf(workflowId), "the run's history");
  quiet(JSON.stringify(run.sourcesTried), "sources_tried");
  quiet(logs.raw.join("\n"), "the log");

  // Quotes found in no page, twice: failed, with nothing written.
  const misquoted = { ...none, industry: { value: "Kilns", url: home, quote: "ovens for bread" } };
  llm.script({ ...misquoted, description: null }, { ...misquoted, description: null });
  const other = newWorkspace();
  const second = await leadAt(other, "website-misquoted", ember);
  const failed = await enrich(other, second);
  assert.deepEqual(tried(failed.run.sourcesTried), [
    { source: "website", outcome: "failed", code: "enrichment_site_ai_failed", filled: [] },
  ]);
  assert.deepEqual([failed.run.status, failed.run.filled], ["done", []]);
  const untouched = (await companyOf(second)) ?? assert.fail("no company");
  assert.deepEqual([untouched.linkedinUrl, untouched.industry], [null, null]);
});

const PEARL_PAGE = "https://www.linkedin.com/company/pearl-quay";
const PEARL_FACTS = {
  companyUrl: PEARL_PAGE,
  name: "Pearl Quay Systems",
  website: "https://www.pearlquay.example/about?ref=1",
  industry: "Maritime software",
  employeeCount: 140,
  employeeRange: { from: 51, to: 200 },
  headquartersCountry: "NL",
  description: "Charts for harbours.",
  foundedYear: 2012,
};
/** A workspace with a tenancy row, and a held lead at a company known by its page and industry. */
async function pageLead(slug: string, accounts: number) {
  const { workspace } = await createOrganizationWithWorkspace();
  const workspaceId = workspace.id;
  const refs: string[] = [];
  for (let i = 0; i < accounts; i++) {
    const ref = `fake-account-${slug}-${i}`;
    linkedinFake.emitWebhook("account.connected", ref);
    await linkedinTesting.createConnectedAccount(workspaceId, { providerAccountRef: ref });
    refs.push(ref);
  }
  const personId = await inRun(workspaceId, async () => {
    const profile = {
      linkedinUrl: `https://linkedin.com/in/${slug}`,
      firstName: "Noor",
      lastName: "Haddad",
      title: "Head of Sales",
      companyName: PEARL_FACTS.name,
      locationText: "Berlin, Germany",
    };
    const { person } = await contacts.upsertPersonFromSource({ ...imported, profile });
    const company = { name: PEARL_FACTS.name, linkedinUrl: PEARL_PAGE, industry: "Shipping" };
    const { company: stored } = await contacts.upsertCompany({ ...imported, company });
    await contacts.linkPersonToCompany({ personId: person.id, companyId: stored.id });
    await contacts.createLeadForPerson({
      personId: person.id,
      source: { kind: "imported", ref: "imp_1" },
    });
    return person.id;
  });
  return { workspaceId, personId, refs };
}

test("the linkedin source reads the company's page through a connected account of the workspace on the LinkedIn fake: only the wanted fields, the website's host as the domain, the band as text, stamped linkedin; one read_company read; no link or fact in the history, sources_tried or a log line", async (t) => {
  useSourceLists({ company: ["linkedin", "company-data"], companyData: ["fake"] });
  linkedinFake.seedCompany(PEARL_PAGE, PEARL_FACTS);
  const { workspaceId, personId, refs } = await pageLead("pearl-lead", 1);
  const workflowId = `enrichment_run-${randomUUID()}`;
  const { run, result } = await enrich(workspaceId, personId, { workflowId });
  t.diagnostic(`history: ${workflowId}`);
  const filled = ["domain", "sizeRange", "country", "description"];
  assert.deepEqual(result, { filled, failed: false });
  assert.deepEqual(tried(run.sourcesTried), [
    { source: "linkedin", outcome: "found", code: null, filled },
  ]);
  assert.deepEqual(
    linkedinFake.recordedCalls
      .filter(({ method }) => method === "getCompany")
      .map(({ input }) => input),
    [{ providerAccountRef: refs[0], companyUrl: "https://linkedin.com/company/pearl-quay" }],
  );
  assert.equal(fake.recordedCalls.length, 0, "company-data has nothing left to fill");
  const company = (await companyOf(personId)) ?? assert.fail("no company");
  const { domain, industry, sizeRange, employeeCount, country, description } = company;
  assert.deepEqual(
    { domain, industry, sizeRange, employeeCount, country, description },
    {
      domain: "pearlquay.example",
      industry: "Shipping",
      sizeRange: "51-200",
      employeeCount: 140,
      country: "NL",
      description: "Charts for harbours.",
    },
  );
  const provenance = company.fieldProvenance as Record<string, unknown>;
  const stamp = { source: "linkedin", provider: "fake", at: NOW.toISOString() };
  assert.deepEqual([provenance.domain, provenance.country], [stamp, stamp]);
  const reads = await app.senderActionLog.findMany({
    where: { workspaceId, kind: "read_company" },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    reads.map(({ outcome, objectRef }) => [outcome, objectRef]),
    [
      ["reserved", null],
      ["ok", null],
    ],
  );
  const quiet = (text: string, what: string) => {
    for (const value of ["pearl", "Pearl", "Charts for harbours", "Maritime"]) {
      assert.ok(!text.includes(value), `${what} holds "${value}"`);
    }
  };
  quiet(await historyOf(workflowId), "the run's history");
  quiet(JSON.stringify(run.sourcesTried), "sources_tried");
  quiet(logs.raw.join("\n"), "the log");
});

test("with no LinkedIn account the linkedin source records no_account, with none with company reads left no_reads_left: no call, no failure, and the next source asked", async () => {
  useSourceLists({ company: ["linkedin", "company-data"], companyData: ["fake"] });
  linkedinFake.seedCompany(PEARL_PAGE, PEARL_FACTS);
  fake.seedCompany(PEARL_PAGE, { name: PEARL_FACTS.name, country: "NL" });
  const skipped = (outcome: string) => [
    { source: "linkedin", outcome, code: null, filled: [] },
    { source: FAKE, outcome: "found", code: null, filled: ["country"] },
  ];
  const lone = await pageLead("pearl-alone", 0);
  const alone = await enrich(lone.workspaceId, lone.personId);
  assert.deepEqual(alone.result, { filled: ["country"], failed: false });
  assert.deepEqual(tried(alone.run.sourcesTried), skipped("no_account"));

  linkedinTesting.useCompanyReadShare(0);
  const spent = await pageLead("pearl-spent", 1);
  const none = await enrich(spent.workspaceId, spent.personId);
  assert.deepEqual(none.result, { filled: ["country"], failed: false });
  assert.deepEqual(tried(none.run.sourcesTried), skipped("no_reads_left"));
  assert.equal(
    linkedinFake.recordedCalls.filter(({ method }) => method === "getCompany").length,
    0,
  );
});

test("country-ai: a lead whose location the place list cannot read gets the AI's sure country, class ai_inferred, the hold released; 'Remote' asks nothing; the model gets the location only; no location in the history, sources_tried or a log line", async () => {
  useSourceLists({ company: [], person: ["country-ai"] });
  const workspaceId = newWorkspace();
  const located = async (slug: string, locationText: string) => {
    const personId = await leadAt(workspaceId, slug, BLUE);
    await inRun(workspaceId, () =>
      contacts.upsertPersonFromSource({
        ...imported,
        profile: { linkedinUrl: `https://linkedin.com/in/${slug}`, locationText },
      }),
    );
    return personId;
  };
  const ruhr = await located("country-ruhr", "Ruhr Region");
  assert.equal((await app.person.findUniqueOrThrow({ where: { id: ruhr } })).locationCountry, null);
  llm.script({ country: "DE", sure: true });
  const workflowId = `country-ai-${randomUUID()}`;
  const { run, result } = await enrich(workspaceId, ruhr, { workflowId });
  assert.deepEqual([run.status, result], ["done", { filled: ["person.country"], failed: false }]);
  assert.deepEqual(tried(run.sourcesTried), [
    { source: "country-ai", outcome: "found", code: null, filled: ["person.country"] },
  ]);
  const person = await app.person.findUniqueOrThrow({ where: { id: ruhr } });
  const stamp = (person.fieldProvenance as Record<string, { source: string; provider: string }>)
    .locationCountry;
  assert.deepEqual(
    [person.locationCountry, stamp?.source, stamp?.provider],
    ["DE", "ai_inferred", "country-ai"],
  );
  assert.equal(await holdOf(ruhr), null);
  assert.equal(llm.recordedCalls.length, 1);
  const sent = JSON.stringify(llm.recordedCalls[0]?.input);
  assert.match(sent, /<location>\\nRuhr\\n<\/location>/);
  holdsNoValue(sent, "the model's call");

  const remote = await located("country-remote", "Remote");
  const none = await enrich(workspaceId, remote);
  assert.deepEqual(tried(none.run.sourcesTried), [
    { source: "country-ai", outcome: "no_place", code: null, filled: [] },
  ]);
  assert.equal(llm.recordedCalls.length, 1, "no call for Remote");
  const quiet = (text: string, what: string) => {
    holdsNoValue(text, what);
    assert.ok(!text.includes("Ruhr"), `${what} holds the location`);
  };
  quiet(await historyOf(workflowId), "the run's history");
  quiet(JSON.stringify([run.sourcesTried, none.run.sourcesTried]), "sources_tried");
  quiet(logs.raw.join("\n"), "the log");
});

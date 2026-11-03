// onboarding's Draft workflow end to end (alpha-p4-020; core/modules/onboarding/README.md "The
// website fetch"), on the slice's Temporal and a schema of its database: onboarding loaded from its
// build by the worker's own loader, its activities through the host's wrapper, against a site this
// test serves on 127.0.0.1; last, the worker host itself, from the Draft's event in the outbox. The
// egress client reaches the site through EGRESS_ALLOW_HOSTS, set here before the platform loads, for
// this process and this port only; the private addresses are literals, refused before any connection.
// A run that read pages then drafts, on the LLM fake with a draft of no value (alpha-p4-030).
// The replay of the recorded history is `pnpm -F worker test:replay`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TenantClient } from "@whytide/db";

const HTML = { "content-type": "text/html; charset=utf-8" };
const html = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const pages: Record<string, string> = {
  "/a/": `<!doctype html><html><head><title>Acme Robotics</title><style>.hero { color: red }</style>
    <script>window.track = "script text";</script></head><body><header><nav>
    <a href="/a/blog">Blog</a><a href="/a/careers">Careers</a><a href="/a/contact">Contact</a>
    <a href="/a/customers">Customers</a><a href="/a/pricing">Pricing</a></nav></header>
    <main><h1>Robots for warehouses</h1><p>Acme builds picking robots.</p>
    <p><a href="/a/product">Our product</a></p></main>
    <footer><a href="/a/about">About us</a><p>Copyright Acme</p></footer></body></html>`,
  "/a/about": html("About Acme", "<h1>About</h1><p>Founded in 2019.</p>"),
  "/a/product": html("The picking arm", "<h1>Product</h1><p>Picks 600 items an hour.</p>"),
  "/a/pricing": html("Pricing", "<h1>Pricing</h1><p>From 2,000 a month.</p>"),
  "/a/customers": html("Customers", "<h1>Customers</h1><p>120 warehouses.</p>"),
  "/a/blog": html("Blog", "<p>News</p>"),
  "/a/careers": html("Careers", "<p>Jobs</p>"),
  "/a/contact": html("Contact", "<p>Write to us</p>"),
  "/b/": html(
    "Beta",
    '<p><a href="/b/about">About</a> <a href="/b/pricing">Pricing</a></p><p><a href="/b/team">Team</a></p>',
  ),
  // Two megabytes in a comment: the page is cut inside it, after its first paragraph.
  "/b/pricing": html("Big pricing", `<p>Plans</p><!--${"x".repeat(2_097_152)}--><p>Past it</p>`),
  "/b/team": html("Team", "<p>Twelve people.</p>"),
};
const requests: string[] = [];
/** /held/ answers once released: a run still fetching when a later Draft starts. */
const [arrival, release] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
const site = createServer((req, res) => {
  const path = req.url ?? "";
  requests.push(path);
  if (path.startsWith("/stall/")) return; // never answers
  if (path === "/held/") {
    arrival.resolve();
    void release.promise.then(() => res.writeHead(200, HTML).end(html("Held", "<p>Late</p>")));
    return;
  }
  if (path === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /b/about\n");
    return;
  }
  const page = pages[path];
  if (page === undefined) res.writeHead(404).end();
  else res.writeHead(200, HTML).end(page);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
// The platform's egress config reads it as it loads, below.
process.env.EGRESS_ALLOW_HOSTS = new URL(origin).host;

const { outboxWriter, withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { collectLogs, createLogger, publish, servicePrincipal } = await import("@whytide/platform");
const { hostActivity } = await import("../src/activities.ts");
const { loadModules } = await import("../src/modules.ts");
const { start } = await import("../src/start.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const { fake, NOTHING_DRAFTED, onboarding } = await import("./fixtures/onboarding.ts");

type FetchResult = { status: string; pages: number; code?: string };
withTestDb();
const env = withTestWorkflowEnvironment();
after(() => {
  site.closeAllConnections();
  site.close();
});
const db = () => asRole("app");
const log = createLogger({ destination: collectLogs().destination });
const loaded = await loadModules(onboarding);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: db(), log })];
  }),
);

/** A record of a new workspace, fetching `website` under a Draft's run, as requestDraft leaves it. */
async function drafted(website: string) {
  const run = {
    workspaceId: `wsp_${randomUUID()}`,
    companyKnowledgeId: `ck_${randomUUID()}`,
    draftRunId: `drun_${randomUUID()}`,
  };
  const { workspaceId, companyKnowledgeId: id, draftRunId } = run;
  const data = { id, workspaceId, sourceUrl: website, fetchStatus: "fetching", draftRunId };
  await db().companyKnowledge.create({ data });
  return run;
}
/** The model's next answer, a draft of no value: a run that read pages ends drafted. */
const scriptDraft = () => {
  fake.reset();
  fake.script(NOTHING_DRAFTED);
};
const draft = (run: Awaited<ReturnType<typeof drafted>>) => {
  scriptDraft();
  return runWorkflow<FetchResult>("onboarding_draft_company_knowledge", run, { activities });
};
const stored = async (workspaceId: string) => ({
  record: await db().companyKnowledge.findFirstOrThrow({ where: { workspaceId } }),
  pages: await db().websitePage.findMany({ where: { workspaceId }, orderBy: { id: "asc" } }),
});
const titleOf = (path: string) => /<title>(.*?)<\/title>/.exec(pages[path] ?? "")?.[1];
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

test("eight pages: five read in the preference order, their text without scripts, styles, navigation or footer, then drafted", async () => {
  const run = await drafted(`${origin}/a/`);
  requests.length = 0;
  assert.deepEqual(await draft(run), { status: "drafted", pages: 5 });
  const order = ["/a/", "/a/about", "/a/product", "/a/pricing", "/a/customers"];
  assert.deepEqual(requests, ["/robots.txt", ...order]);
  const { record, pages: read } = await stored(run.workspaceId);
  assert.deepEqual(
    read.map((page) => [page.url, page.title, page.status]),
    order.map((path) => [`${origin}${path}`, titleOf(path), "fetched"]),
  );
  assert.equal(read[0]?.text, "# Robots for warehouses\nAcme builds picking robots.\nOur product");
  assert.ok(read.every((page) => page.fetchedAt <= new Date() && page.contentHash.length === 64));
  assert.deepEqual([record.fetchStatus, record.fetchError], ["drafted", null]);
});

test("a private address ends failed with egress_blocked_address and writes no page", async () => {
  for (const website of ["http://10.255.255.1/", "http://169.254.169.254/"]) {
    const run = await drafted(website);
    const failed = { status: "failed", pages: 0, code: "egress_blocked_address" };
    assert.deepEqual(await draft(run), failed);
    const { record, pages: read } = await stored(run.workspaceId);
    assert.deepEqual([record.fetchStatus, record.fetchError, read], ["failed", failed.code, []]);
  }
});

test("a page past one megabyte is cut and truncated; a path robots.txt disallows is skipped; a stalled site fails within sixty seconds", async () => {
  const run = await drafted(`${origin}/b/`);
  requests.length = 0;
  assert.deepEqual(await draft(run), { status: "drafted", pages: 3 });
  assert.deepEqual(requests, ["/robots.txt", "/b/", "/b/pricing", "/b/team"]);
  assert.deepEqual(
    (await stored(run.workspaceId)).pages.map((page) => [page.url, page.status, page.text]),
    [
      [`${origin}/b/`, "fetched", "About Pricing\nTeam"],
      [`${origin}/b/pricing`, "truncated", "Plans"],
      [`${origin}/b/team`, "fetched", "Twelve people."],
    ],
  );
  const stalled = await drafted(`${origin}/stall/`);
  const started = performance.now();
  const failed = { status: "failed", pages: 0, code: "egress_timeout" };
  assert.deepEqual(await draft(stalled), failed);
  assert.ok(performance.now() - started < 60_000);
  assert.equal((await stored(stalled.workspaceId)).record.fetchError, failed.code);
});

test("a second Draft replaces the pages, none twice; a run a later Draft superseded writes nothing, before its fetch or after it", async () => {
  const first = await drafted(`${origin}/a/`);
  await draft(first);
  const before = (await stored(first.workspaceId)).pages;
  /** A later Draft, as requestDraft starts it: a new run on the record. */
  const supersede = async (data: { sourceUrl?: string } = {}) => {
    const draftRunId = `drun_${randomUUID()}`;
    const where = { id: first.companyKnowledgeId };
    await db().companyKnowledge.update({ where, data: { ...data, draftRunId } });
    return { ...first, draftRunId };
  };
  assert.deepEqual(await draft(await supersede()), { status: "drafted", pages: 5 });
  const after = (await stored(first.workspaceId)).pages;
  const urls = after.map((page) => page.url);
  assert.deepEqual([urls, new Set(urls).size], [before.map((page) => page.url), 5]);
  assert.ok(after.every((page) => !before.some((old) => old.id === page.id)));
  const superseded = { status: "superseded", pages: 0 };
  assert.deepEqual(await draft(first), superseded);
  const late = draft(await supersede({ sourceUrl: `${origin}/held/` }));
  await arrival.promise;
  await supersede();
  release.resolve();
  assert.deepEqual(await late, superseded);
  assert.deepEqual((await stored(first.workspaceId)).pages, after);
});

test("through the host: a Draft's event starts one run by onboarding.draft:<workspace>:<run>, which reads the site and drafts; a second delivery starts none", async () => {
  // onboarding's commands and events from its build, the files the worker's loader imports.
  const built = (file: string) =>
    new URL(`../../../modules/onboarding/dist/${file}`, import.meta.url);
  const { getCompanyKnowledge, saveCompanyKnowledge } = await import(
    built("domain/commands.js").href
  );
  const { requestDraft } = await import(built("domain/draft.js").href);
  const { events } = await import(built("events.js").href);
  const taskQueue = `test-${randomUUID()}`;
  const host = await start({ modules: onboarding, taskQueue, healthPort: 0, client: db(), log });
  try {
    const workspaceId = `wsp_${randomUUID()}`;
    const tenant = { workspaceId, principal: servicePrincipal("test") };
    const inRun = <T>(fn: (tx: TenantClient) => Promise<T>) =>
      withTenant(tenant, fn, { client: db() });
    scriptDraft();
    const record = await inRun(async () => {
      const current = await getCompanyKnowledge(workspaceId);
      await saveCompanyKnowledge({ ...current, sourceUrl: `${origin}/a/` });
      return requestDraft(workspaceId);
    });
    const ended = await until(async () => {
      const row = await db().companyKnowledge.findFirstOrThrow({ where: { workspaceId } });
      return row.fetchStatus === "fetching" || row.fetchStatus === "fetched" ? undefined : row;
    });
    assert.deepEqual([ended.fetchStatus, (await stored(workspaceId)).pages.length], ["drafted", 5]);
    const { draftRunId } = ended;
    const run = env.client.workflow.getHandle(`onboarding.draft:${workspaceId}:${draftRunId}`);
    assert.deepEqual(await run.result(), { status: "drafted", pages: 5 });
    const { runId } = await run.describe();
    const payload = { workspaceId, companyKnowledgeId: record.id, draftRunId };
    const name = events["onboarding.draft_requested"];
    const again = await inRun((tx) => publish(outboxWriter(tx, workspaceId), name, payload));
    const delivered = await until(async () => {
      const row = await db().outboxEntry.findUniqueOrThrow({ where: { id: again } });
      return row.deliveredAt === null && row.lastError === null ? undefined : row;
    });
    assert.deepEqual([delivered.lastError, (await run.describe()).runId], [null, runId]);
  } finally {
    await host.close();
  }
});

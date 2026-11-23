// signals' settings from the environment (env-settings-b; README.md "Settings"), on the worktree's
// database: set to 30 reads kept and 200 events rated before the module loads, a daily source is due
// only with more than 30 reads left, and a run's rating picks the source's 200 oldest unrated events
// of 201; SIGNALS_RESEARCH_EVERY_DAYS (gamma-wr-030) set to 30, a research source's last run 20 days
// ago is not due, and the source answered says every 30 days; SIGNALS_RESEARCH_RECHECK_DAYS
// (gamma-wr-040) set to 30, a query asked 20 days ago is refused by the plan's gate and one asked 40
// days ago is kept; SIGNALS_RESEARCH_SEARCHES_PER_RUN (gamma-wr-041) and SIGNALS_RESEARCH_PAGES_PER_RUN (gamma-wr-045), SIGNALS_RESEARCH_COMPANIES_PER_RUN and SIGNALS_RESEARCH_SITE_MAX_PAGES (gamma-wr-050) are read with them. Not an integer of 1 or more, each setting stops the module's load with config_invalid
// naming it, while a large value loads, read in a process of its own; the api's and the worker's
// starts load the module so. tests/share.test.ts runs the share with the default, and the worker's
// tests/signals-rating.test.ts the rating's 100.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.SIGNALS_READS_KEPT_FOR_SENDS = "30";
process.env.SIGNALS_RATE_MAX_EVENTS_PER_RUN = "200";
process.env.SIGNALS_RESEARCH_EVERY_DAYS = "30";
process.env.SIGNALS_RESEARCH_RECHECK_DAYS = "30";
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
const { planResearchRun } = await import("../domain/research/plan.ts");
const { selectRatings } = await import("../domain/rate/rate.ts");
const { isDue } = await import("../domain/schedule/daily.ts");
const { writeDueResearchRuns } = await import("../domain/schedule/research.ts");
const { ids } = await import("../ids.ts");
const { settings } = await import("../settings.ts");
const { createPlaybook } = await import("@whytide/playbooks/testing");
const { createSignalRun, createSignalSource, useSignalsClient } = await import(
  "../testing/index.ts"
);

withTestDb();
const app = asRole("app");
useSignalsClient(app);

test("30 reads kept: a daily source with no run today is due with 31 reads left, not with 30", () => {
  assert.equal(settings.SIGNALS_READS_KEPT_FOR_SENDS, 30);
  const reads = { quotaDay: "2026-11-16", windowOpen: true };
  assert.deepEqual(
    [31, 30].map((left) => isDue({ ...reads, left }, [])),
    [true, false],
  );
});

test("200 events rated a run: the select picks the source's 200 oldest unrated events with words, of 201", async () => {
  assert.equal(settings.SIGNALS_RATE_MAX_EVENTS_PER_RUN, 200);
  const workspaceId = "wsp_signals_settings";
  const offer = { oneLiner: "Pipeline forecasts", products: ["Forecasts"], painPoints: [] };
  await app.companyKnowledge.create({ data: { id: newId("ck"), workspaceId, ...offer } });
  const source = await createSignalSource({ workspaceId, label: "Launch post" });
  const start = Date.parse("2026-11-01T09:00:00Z");
  const events = Array.from({ length: 201 }, (_, at) => ({
    id: newId(ids.signal_event),
    occurredAt: new Date(start + at * 60_000),
  }));
  await app.signalEvent.createMany({
    data: events.map(({ id, occurredAt }) => ({
      ...{ id, workspaceId, personId: `per_${id}`, sourceId: source.id, kind: "post_engagement" },
      ...{ dedupeKey: `test:${id}`, occurredAt },
    })),
  });
  await app.evidence.createMany({
    data: events.map(({ id, occurredAt }) => ({
      ...{ id: newId(ids.evidence), workspaceId, eventId: id, url: "https://example.test/post" },
      ...{ excerpt: "We need forecasts", commentText: "We need forecasts", reaction: "comment" },
      ...{ author: "Test Engager", capturedAt: occurredAt },
    })),
  });
  const principal = servicePrincipal("signals_test");
  const picked = await withTenant(
    { workspaceId, principal },
    () => selectRatings({ workspaceId, sourceId: source.id, runId: "srun_settings" }),
    { client: app },
  );
  assert.deepEqual(
    picked,
    events.slice(0, 200).map(({ id }) => id),
  );
});

test("30 days between research runs: a research source in an agent whose last run started 20 days ago is not due, one 31 days ago is", async () => {
  assert.equal(settings.SIGNALS_RESEARCH_EVERY_DAYS, 30);
  const workspaceId = "wsp_signals_research_days";
  const now = new Date("2026-11-16T12:00:00Z");
  const days = (count: number) => new Date(now.getTime() - count * 24 * 60 * 60 * 1000);
  const config = { focus: "traders of grain" };
  const made = { workspaceId, kind: "web_research", config, senderAccountId: null };
  const sources = [await createSignalSource({ ...made, label: "20" })];
  sources.push(await createSignalSource({ ...made, label: "31" }));
  const [recent, old] = sources.map(({ id }) => id) as [string, string];
  await createPlaybook({
    workspaceId,
    icpId: "icp_days",
    ownerUserId: "usr_test",
    sourceIds: [recent, old],
  });
  await createSignalRun({ workspaceId, sourceId: recent, status: "done", startedAt: days(20) });
  await createSignalRun({ workspaceId, sourceId: old, status: "done", startedAt: days(31) });
  const principal = servicePrincipal("signals_test");
  const written = await withTenant({ workspaceId, principal }, () => writeDueResearchRuns(now), {
    client: app,
  });
  assert.equal(written, 1);
  const scheduled = await app.signalRun.findMany({ where: { workspaceId, status: "scheduled" } });
  assert.deepEqual(
    scheduled.map(({ sourceId }) => sourceId),
    [old],
  );
});

test("30 days to re-check: a query asked 20 days ago is refused by the plan's gate, one asked 40 days ago is kept", async () => {
  assert.equal(settings.SIGNALS_RESEARCH_RECHECK_DAYS, 30);
  await loadAgentTasks([new URL("../agents/research-plan/task.ts", import.meta.url).href]);
  const llm = (await getAdapter(
    llmPort,
    "fake",
  )) as unknown as import("@whytide/providers").LlmFake;
  const workspaceId = "wsp_signals_recheck";
  const now = new Date("2026-11-16T12:00:00Z");
  const principal = servicePrincipal("signals_test");
  const inRun = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
  const { icp } = await inRun(() => readIcpForScoring(workspaceId));
  await app.icp.update({ where: { id: icp.id }, data: { countries: ["PL"] } });
  const config = { focus: "makers of cold-chain loggers", languages: ["pl"] };
  const made = { workspaceId, kind: "web_research", config, senderAccountId: null };
  const { id: sourceId } = await createSignalSource({ ...made, label: "Recheck" });
  const earlier = await createSignalRun({ workspaceId, sourceId, status: "done" });
  const plan = await app.signalResearchPlan.create({
    data: { id: newId("rpl"), workspaceId, sourceId, runId: earlier.id, words: [], placeIds: [] },
  });
  const asked = (text: string, days: number, position: number) => ({
    ...{ id: newId("rqy"), workspaceId, planId: plan.id, sourceId, position, text },
    ...{ placeId: "web_search", country: "PL", language: "pl", resultCount: 10 },
    askedAt: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
  });
  await app.signalResearchQuery.createMany({
    data: [asked("pytanie z zeszlego tygodnia", 20, 1), asked("pytanie sprzed miesiaca", 40, 2)],
  });
  const query = (text: string) => ({ place: "web_search", country: "PL", language: "pl", text });
  const queries = ["pytanie z zeszlego tygodnia", "pytanie sprzed miesiaca"].map(query);
  llm.script({ words: [], places: ["web_search"], queries });
  const run = await createSignalRun({ workspaceId, sourceId, status: "running" });
  const ref = { workspaceId, sourceId, runId: run.id };
  const planned = await planResearchRun(ref, (fn) => inRun(fn), now);
  assert.deepEqual(planned, { status: "planned", queries: 1, refused: 1 });
  const kept = await app.signalResearchQuery.findMany({ where: { sourceId, askedAt: null } });
  assert.deepEqual(
    kept.map(({ text }) => text),
    ["pytanie sprzed miesiaca"],
  );
});

/** What a process with `env` set reads as the module loads: the settings, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const script = [
    "try {",
    `  await import(${JSON.stringify(new URL(entry, import.meta.url).href)});`,
    `  const { settings } = await import(${JSON.stringify(new URL("../settings.ts", import.meta.url).href)});`,
    "  const { SIGNALS_READS_KEPT_FOR_SENDS: kept, SIGNALS_RATE_MAX_EVENTS_PER_RUN: rated } = settings;",
    "  const { SIGNALS_RESEARCH_EVERY_DAYS: every, SIGNALS_RESEARCH_RECHECK_DAYS: recheck } = settings;",
    "  const { SIGNALS_RESEARCH_SEARCHES_PER_RUN: searches } = settings;",
    "  const { SIGNALS_RESEARCH_PAGES_PER_RUN: pages } = settings;",
    "  const { SIGNALS_RESEARCH_COMPANIES_PER_RUN: companies } = settings;",
    "  const { SIGNALS_RESEARCH_SITE_MAX_PAGES: site } = settings;",
    "  const { SIGNALS_RESEARCH_PEOPLE_PER_COMPANY: people } = settings;",
    "  console.log(JSON.stringify([kept, rated, every, recheck, searches, pages, companies, site, people]));",
    "} catch (error) {",
    "  const names = error.details.variables.map((variable) => variable.split(':')[0]);",
    "  console.log(JSON.stringify([error.code, error.details.block, names]));",
    "}",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: { APP_ENV: "test", PROVIDER_LLM: "fake", ...env },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("each of the eight is an integer of 1 or more with no maximum, 20, 100, 7, 180, 60, 40, 25 and 5 unset or empty; otherwise the module's load stops on config_invalid naming it, the build's index included", () => {
  const KEPT = "SIGNALS_READS_KEPT_FOR_SENDS";
  const RATED = "SIGNALS_RATE_MAX_EVENTS_PER_RUN";
  const DAYS = "SIGNALS_RESEARCH_EVERY_DAYS";
  const RECHECK = "SIGNALS_RESEARCH_RECHECK_DAYS";
  const SEARCHES = "SIGNALS_RESEARCH_SEARCHES_PER_RUN";
  const PAGES = "SIGNALS_RESEARCH_PAGES_PER_RUN";
  const COMPANIES = "SIGNALS_RESEARCH_COMPANIES_PER_RUN";
  const SITE = "SIGNALS_RESEARCH_SITE_MAX_PAGES";
  const empty = { [KEPT]: "", [RATED]: "", [DAYS]: "", [RECHECK]: "", [SEARCHES]: "", [PAGES]: "" };
  assert.deepEqual(
    [loaded({}), loaded({ ...empty, [COMPANIES]: "", [SITE]: "" })],
    [
      [20, 100, 7, 180, 60, 40, 25, 5, 3],
      [20, 100, 7, 180, 60, 40, 25, 5, 3],
    ],
  );
  const large = {
    [KEPT]: "1",
    [RATED]: "1000",
    [DAYS]: "3650",
    [RECHECK]: "36500",
    [SEARCHES]: "100000",
    [PAGES]: "100000",
    [COMPANIES]: "100000",
    [SITE]: "1000",
  };
  assert.deepEqual(loaded(large), [1, 1000, 3650, 36500, 100000, 100000, 100000, 1000, 3]);
  for (const name of [KEPT, RATED, DAYS, RECHECK, SEARCHES, PAGES, COMPANIES, SITE]) {
    const invalid = ["config_invalid", "modules/signals", [name]];
    for (const value of ["0", "-1", "1.5", "one"]) {
      assert.deepEqual(loaded({ [name]: value }), invalid, `${name}=${value}`);
    }
    // The hosts load the module's build: its index stops the same way.
    assert.deepEqual(loaded({ [name]: "0" }, "../dist/index.js"), invalid, `${name} at load`);
  }
});

test("SIGNALS_CREDITS_PER_RESEARCHED_COMPANY (gamma-wr-051) is a whole number from 0 to 100, 1 unset or empty, the credits of one company judged", () => {
  const NAME = "SIGNALS_CREDITS_PER_RESEARCHED_COMPANY";
  const priced = (value: string) => {
    const script = [
      `const { settings } = await import(${JSON.stringify(new URL("../settings.ts", import.meta.url).href)});`,
      "console.log(JSON.stringify(settings.SIGNALS_CREDITS_PER_RESEARCHED_COMPANY));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: import.meta.dirname,
      env: { APP_ENV: "test", PROVIDER_LLM: "fake", [NAME]: value },
      encoding: "utf8",
    });
    return child.status === 0 ? JSON.parse(child.stdout) : "config_invalid";
  };
  assert.deepEqual(["", "0", "1", "3", "100"].map(priced), [1, 0, 1, 3, 100]);
  for (const value of ["-1", "101", "1.5", "one"]) {
    assert.equal(priced(value), "config_invalid", `${NAME}=${value}`);
  }
});

test("SIGNALS_RESEARCH_PEOPLE_PER_COMPANY (gamma-wr-060) is an integer from 1 to 10, 3 unset or empty: a privacy cap, so 11 and more stop the module's load on config_invalid naming it, the build's index included", () => {
  const PEOPLE = "SIGNALS_RESEARCH_PEOPLE_PER_COMPANY";
  const people = (env: Record<string, string>, entry?: string) =>
    (loaded(env, entry) as number[])[8];
  assert.deepEqual([people({}), people({ [PEOPLE]: "" })], [3, 3]);
  assert.deepEqual([people({ [PEOPLE]: "1" }), people({ [PEOPLE]: "10" })], [1, 10]);
  const invalid = ["config_invalid", "modules/signals", [PEOPLE]];
  for (const value of ["0", "-1", "11", "1000", "1.5", "one"]) {
    assert.deepEqual(loaded({ [PEOPLE]: value }), invalid, `${PEOPLE}=${value}`);
  }
  assert.deepEqual(loaded({ [PEOPLE]: "11" }, "../dist/index.js"), invalid, "at load");
});

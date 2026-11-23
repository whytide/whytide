// A source's contract as the step keeps it (README "Sources"; domain/step.ts), one step at a time on
// the worktree's database: the run's workspace and company ids beside the minimum input, and a run of
// that workspace a source may open for its own reads; a skip in the source's own word kept as its
// outcome, which tries the company only when ANSWERED lists it; the provider that answered stamping
// the facts; an answer off those rules recorded failed, enrichment_source_invalid; a late answer,
// past the step's timeout, writing nothing once the source is recorded or the run ended; a db step
// tried again answering the source's record; and a company's fact older than ENRICHMENT_FACT_DAYS
// asked again, renewed by a source that brings it and left by one that brings nothing (gamma-rf-020).
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  getCompany,
  linkPersonToCompany,
  upsertCompany,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, currentTenant, servicePrincipal } from "@whytide/platform";
import { DAY_MS } from "../domain/constants.ts";
import { useLog } from "../domain/log.ts";
import { triedCompany } from "../domain/plan.ts";
import { sourcesTried } from "../domain/readers.ts";
import { finishRun, prepareRun, recordTried } from "../domain/runs.ts";
import {
  defineSource,
  type SourceAnswer,
  type SourceContext,
  type SourceInput,
} from "../domain/sources/define.ts";
import { loadSources } from "../domain/sources/index.ts";
import { askSource } from "../domain/step.ts";
import { createRun, useClock, useEnrichmentClient, useSourceLists } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useEnrichmentClient(asRole("app"));
const WS = "wsp_step_test";
const SOURCE = "test-step";
const principal = servicePrincipal("enrichment_test");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WS, principal }, fn, { client: asRole("app") });
const runs = { tenant: run };

/** What the source answers in the test under way, and the inputs it got. */
type Answer = (input: SourceInput, context: SourceContext) => Promise<SourceAnswer>;
let answer: Answer = async () => ({ found: false });
const seen: SourceInput[] = [];
defineSource({
  name: SOURCE,
  kind: "company",
  fills: ["industry", "description"],
  needs: ["domain"],
  activityKind: "db",
  provenance: { source: "web_search", provider: "test-step" },
  run: (input, context) => {
    seen.push(input);
    return answer(input, context);
  },
});
let logs = collectLogs();
beforeEach(() => {
  useSourceLists({ company: [SOURCE], person: [], companyData: [] });
  seen.length = 0;
  logs = collectLogs();
  useLog(createLogger({ destination: logs.destination }));
});
afterEach(() => {
  useLog(undefined);
  useClock(undefined);
});

/** A lead of the workspace with a company by its domain, and its request's run, prepared. */
async function preparedRun(slug: string) {
  const { personId, companyId } = await run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    const company = { name: `${slug} Ltd`, domain: `${slug}.example` };
    const made = await upsertCompany({ source: "import", provider: "csv", company });
    await linkPersonToCompany({ personId: person.id, companyId: made.company.id });
    return { personId: person.id, companyId: made.company.id };
  });
  const { runId } = await run(() =>
    createRun({ personId, trigger: "request", requestKey: `request:${slug}` }),
  );
  const { sources } = await loadSources();
  await run(() => prepareRun(runId, sources));
  return { runId, companyId };
}
const ask = (runId: string) => askSource(runs, { runId, source: SOURCE });
const tried = async (runId: string) =>
  (await run(() => sourcesTried(runId))).map(({ ms: _ms, ...entry }) => entry);
const companyOf = (companyId: string) => run(() => getCompany(companyId));
const warned = () => logs.lines().map(({ level, provider, code }) => [level, provider, code]);

/** The runs' time in the gamma-rf-020 cases, the facts' stamps counted back from it. */
const NOW = new Date("2026-11-13T10:00:00Z");
/** The workspace's company by its domain, its industry stamped by open data `days` before NOW. */
const oldCompany = (slug: string, days: number) =>
  run(async () => {
    const fetchedAt = new Date(NOW.getTime() - days * DAY_MS);
    const company = { name: `${slug} Ltd`, domain: `${slug}.example`, industry: "Shipping" };
    const stamp = { source: "open_data", provider: "wikidata" } as const;
    return (await upsertCompany({ ...stamp, company: { ...company, fetchedAt } })).company.id;
  });
/** A new lead of the company and its new_lead run, prepared: the run's id and its plan. */
async function newLeadRun(slug: string, companyId: string) {
  const personId = await run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await linkPersonToCompany({ personId: person.id, companyId });
    return person.id;
  });
  const requestKey = `new_lead:${personId}`;
  const { runId } = await run(() => createRun({ personId, trigger: "new_lead", requestKey }));
  const { sources } = await loadSources();
  return { runId, plan: await run(() => prepareRun(runId, sources)) };
}

test("a source gets the run's workspace and company ids beside the minimum input, and opens a run of that workspace for its own reads", async () => {
  const { runId, companyId } = await preparedRun("ids");
  answer = async (input, context) => {
    const read = await context.tenant(async () => ({
      workspaceId: currentTenant().workspaceId,
      name: (await getCompany(input.companyId ?? "")).name,
    }));
    assert.deepEqual(read, { workspaceId: WS, name: "ids Ltd" });
    return { found: true, facts: { industry: "Maritime software" } };
  };
  assert.deepEqual(await ask(runId), {
    outcome: "found",
    filled: ["industry"],
    inputsAdded: false,
  });
  assert.deepEqual(seen, [
    {
      workspaceId: WS,
      companyId,
      company: { domain: "ids.example", name: "ids Ltd" },
      wanted: ["industry", "description"],
    },
  ]);
});

test("a skip in the source's own word is its outcome, with no code and no warning, and tries the company only when ANSWERED lists it", async () => {
  const { runId } = await preparedRun("skip");
  answer = async () => ({ found: false, outcome: "no_account" });
  assert.deepEqual(await ask(runId), { outcome: "no_account", filled: [], inputsAdded: false });
  const entries = await tried(runId);
  assert.deepEqual(entries, [{ source: SOURCE, outcome: "no_account", code: null, filled: [] }]);
  assert.equal(
    triedCompany({ wanted: ["industry"], tried: await run(() => sourcesTried(runId)) }),
    false,
  );
  assert.deepEqual(warned(), []);

  const plain = await preparedRun("plain");
  answer = async () => ({ found: false });
  await ask(plain.runId);
  assert.deepEqual(await tried(plain.runId), [
    { source: SOURCE, outcome: "not_found", code: null, filled: [] },
  ]);
});

test("the provider that answered stamps the facts, the class the definition's", async () => {
  const { runId, companyId } = await preparedRun("brave");
  answer = async () => ({ found: true, facts: { industry: "Shipping" }, provider: "brave" });
  await ask(runId);
  const company = await companyOf(companyId);
  assert.equal(company.industry, "Shipping");
  const stamp = company.fieldProvenance.industry;
  assert.deepEqual([stamp?.source, stamp?.provider], ["web_search", "brave"]);
});

test("an answer off the rules, an outcome that is no code or is the step's own, or a provider off its form, is recorded failed as enrichment_source_invalid with one warning, and writes nothing", async () => {
  const cases: [string, SourceAnswer][] = [
    ["not-a-code", { found: false, outcome: "Not found!" }],
    ["found", { found: false, outcome: "found" }],
    ["failed", { found: false, outcome: "failed" }],
    ["provider", { found: true, facts: { industry: "Shipping" }, provider: "Brave Search" }],
  ];
  for (const [slug, given] of cases) {
    const { runId, companyId } = await preparedRun(`off-${slug}`);
    answer = async () => given;
    logs = collectLogs();
    useLog(createLogger({ destination: logs.destination }));
    assert.deepEqual(await ask(runId), { outcome: "failed", filled: [], inputsAdded: false });
    assert.deepEqual(
      await tried(runId),
      [{ source: SOURCE, outcome: "failed", code: "enrichment_source_invalid", filled: [] }],
      slug,
    );
    assert.deepEqual(warned(), [["warn", SOURCE, "enrichment_source_invalid"]], slug);
    assert.equal((await companyOf(companyId)).industry, null, slug);
  }
});

test("a late answer, past the step's timeout, writes nothing once the workflow recorded the source failed, nor once the run ended", async () => {
  const late = async (slug: string, meanwhile: (runId: string) => Promise<unknown>) => {
    const { runId, companyId } = await preparedRun(slug);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = async () => {
      await gate;
      return { found: true, facts: { industry: "Shipping" } };
    };
    const asking = ask(runId);
    await meanwhile(runId);
    release();
    const answered = await asking;
    return { runId, answered, company: await companyOf(companyId) };
  };
  const timedOut = { source: SOURCE, outcome: "failed", code: "activity_timeout", filled: [] };
  const recorded = await late("late-recorded", (runId) =>
    run(() => recordTried(runId, { ...timedOut, ms: 0 })),
  );
  assert.equal(recorded.company.industry, null);
  assert.deepEqual(await tried(recorded.runId), [timedOut]);
  assert.deepEqual(recorded.answered, { outcome: "failed", filled: [], inputsAdded: false });

  const ended = await late("late-ended", (runId) => run(() => finishRun(runId, false)));
  assert.equal(ended.company.industry, null);
  assert.deepEqual(await tried(ended.runId), []);
});

test("a db step tried again after its write answers the source's record and writes nothing more", async () => {
  const { runId, companyId } = await preparedRun("again");
  answer = async () => ({ found: true, facts: { industry: "Shipping" } });
  const first = await ask(runId);
  assert.deepEqual(first, { outcome: "found", filled: ["industry"], inputsAdded: false });
  answer = async () => ({ found: true, facts: { industry: "Other", description: "Ships." } });
  assert.deepEqual(await ask(runId), first);
  const company = await companyOf(companyId);
  assert.deepEqual([company.industry, company.description], ["Shipping", null]);
  assert.deepEqual(await tried(runId), [
    { source: SOURCE, outcome: "found", code: null, filled: ["industry"] },
  ]);
});

test("a company's industry stamped 181 days before the run starts is wanted for a new lead, and a source that brings it replaces the value and its stamp, the run's filled naming it; stamped 179 days before, it is not wanted and stays (gamma-rf-020)", async () => {
  useClock(() => NOW);
  const companyId = await oldCompany("old", 181);
  const old = await newLeadRun("old-lead", companyId);
  assert.ok(old.plan.wanted.includes("industry"));
  answer = async () => ({ found: true, facts: { industry: "Maritime software" } });
  assert.deepEqual(await ask(old.runId), {
    outcome: "found",
    filled: ["industry"],
    inputsAdded: false,
  });
  assert.deepEqual(seen.at(-1)?.wanted, ["industry", "description"]);
  assert.deepEqual(await tried(old.runId), [
    { source: SOURCE, outcome: "found", code: null, filled: ["industry"] },
  ]);
  const renewed = await companyOf(companyId);
  const stamp = { source: "web_search", provider: "test-step", at: NOW.toISOString() };
  assert.deepEqual(
    [renewed.industry, renewed.fieldProvenance.industry],
    ["Maritime software", stamp],
  );

  const youngId = await oldCompany("young", 179);
  const young = await newLeadRun("young-lead", youngId);
  assert.ok(!young.plan.wanted.includes("industry"));
  answer = async () => ({ found: true, facts: { industry: "Other", description: "Ships." } });
  assert.deepEqual(await ask(young.runId), {
    outcome: "found",
    filled: ["description"],
    inputsAdded: false,
  });
  const kept = await companyOf(youngId);
  const old179 = new Date(NOW.getTime() - 179 * DAY_MS).toISOString();
  const openData = { source: "open_data", provider: "wikidata", at: old179 };
  assert.deepEqual([kept.industry, kept.fieldProvenance.industry], ["Shipping", openData]);
});

test("a run whose source brings nothing for an old fact leaves the value and its stamp; the company's next new lead within the retry days ends enriched_recently (gamma-rf-020)", async () => {
  useClock(() => NOW);
  const companyId = await oldCompany("stale", 181);
  const before = await companyOf(companyId);
  const first = await newLeadRun("stale-first", companyId);
  assert.ok(first.plan.wanted.includes("industry"));
  answer = async () => ({ found: false });
  assert.deepEqual(await ask(first.runId), {
    outcome: "not_found",
    filled: [],
    inputsAdded: false,
  });
  await run(() => finishRun(first.runId, false));
  const after = await companyOf(companyId);
  assert.deepEqual(
    [after.industry, after.fieldProvenance.industry],
    ["Shipping", before.fieldProvenance.industry],
  );
  const next = await newLeadRun("stale-next", companyId);
  const row = await asRole("app").enrichmentRun.findUniqueOrThrow({ where: { id: next.runId } });
  assert.deepEqual([row.skipReason, next.plan.wanted], ["enriched_recently", []]);
  assert.equal(seen.length, 1, "the source was asked once");
});

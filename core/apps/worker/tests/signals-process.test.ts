// signals' processing end to end (alpha-p8-030; core/modules/signals/README.md "Processing"), on the
// slice's Temporal and a schema of its database: the run of signals-run.test.ts, credits, linkedin and
// signals loaded from their builds by the worker's own loader, on the LinkedIn, files and LLM fakes,
// now with the cheap drops, a profile read per candidate left and the processing; then the hand-off
// through the worker host with qualification loaded: signals.person_found's ids start qualification's
// batch, which scores them on the LLM fake. linkedin's clock is a working Wednesday at 10:00 UTC. A
// profile the provider cannot read is skipped, and three in a row end the run (fix-profile-skip);
// within the hour linkedin's third error ends it first, the account paused (beta-p6-020); a stop
// thrown after a profile read's reservation ends it at that read (beta-p6-040).
// Each profile read costs a credit of signals.engager, committed when the profile came and released
// otherwise; a candidate dropped before its read costs nothing (beta-p1-090). Competitors' staff are
// dropped by the noise rules before the read and after it, recruiters and job seekers before it by
// the rules a batch the triage could not answer takes (gamma-p5-030): here every triage step is the
// rules', the agent's being tests/signals-triage.test.ts'. After the read, a recruiter's profile is
// a pending lead (signals-triage-ai).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TenantClient } from "@whytide/db";
import type { FakeEngager as Engager, LinkedinFake, LlmFake } from "@whytide/providers";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.PROVIDER_LLM = "fake";

const { loadAgentTasks } = await import("@whytide/ai");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { filesPort, getAdapter, linkedinPort, llmPort } = await import("@whytide/providers");
const { ids: creditsIds } = await import("@whytide/credits");
const { grantAllowance, useCreditsClient } = await import("@whytide/credits/testing");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { start } = await import("../src/start.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
const contacts = await built("contacts/dist/index.js");
const { useEnrichmentHold, useHashSalt } = await built("contacts/dist/testing/index.js");
const { readIcpForScoring } = await built("icp/dist/index.js");
const linkedin = await built("linkedin/dist/testing/index.js");
const { useQualificationClient } = await built("qualification/dist/testing/index.js");
const tenancy = await built("tenancy/dist/testing/index.js");

const testDb = withTestDb();
const env = withTestWorkflowEnvironment();
const db = () => asRole("app");
useCreditsClient(db());
linkedin.useLinkedinClient(db());
tenancy.useTenancyClient(db());
useQualificationClient(db());
linkedin.useSecretKeys(platform.loadMasterKeys({ APP_MASTER_KEY: platform.newMasterKey() }));
useHashSalt("test-salt-".repeat(4));
// A new lead is judged at once here; contacts' enrichment-hold.test.ts holds one (gamma-en-040).
useEnrichmentHold(0);
await loadAgentTasks();
const log = platform.createLogger({ destination: platform.collectLogs().destination });
const names = new Set(["credits", "linkedin", "signals"]);
const loaded = await loadModules(moduleLoaders.filter(({ name }) => names.has(name)));
await startModules(loaded, log);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: db(), log })];
  }),
);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const llm = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const files = await getAdapter(filesPort, "fake");
const principal = platform.servicePrincipal("signals_test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: db() });
const WEDNESDAY = new Date("2026-10-07T10:00:00.000Z");
const THURSDAY = new Date("2026-10-08T10:00:00.000Z");
const TITLE = "Head of Revenue Operations";
const ICP = {
  titles: [TITLE],
  seniorities: ["head"],
  industries: ["Software"],
  sizeRanges: ["51-200"],
  countries: ["DE"],
};
const COMPANY = {
  companyName: "Blue Harbor Labs",
  companyUrl: "https://www.linkedin.com/company/blue-harbor",
};
const verdict = (criterion: string, evidence: string) => ({ criterion, verdict: "met", evidence });
const answer = () => ({
  verdicts: [
    verdict("title_function", TITLE),
    verdict("seniority", TITLE),
    { criterion: "company_size", verdict: "unknown", evidence: "" },
    { criterion: "industry", verdict: "unknown", evidence: "" },
    verdict("location", "Berlin, Germany"),
    { criterion: "must_haves", verdict: "unknown", evidence: "" },
  ],
  disqualifiers: [],
  summary: "A revenue operations head in Germany.",
});

/** An engager `slug`, a minute older per `at`, its profile seeded with `profile` when given. */
function engager(slug: string, at: number, profile?: Record<string, string>, extra = {}): Engager {
  const profileUrl = `https://www.linkedin.com/in/${slug}`;
  const name = `Name of ${slug}`;
  if (profile) {
    const [firstName, lastName] = ["Name", `of ${slug}`];
    const base = { providerMemberRef: slug, profileUrl, firstName, lastName, title: TITLE };
    const seeded = { ...base, headline: `Headline of ${slug}`, locationText: "Berlin, Germany" };
    fake.seedProfile({ ...seeded, ...COMPANY, ...profile });
  }
  const engagedAt = new Date(Date.now() - 3_600_000 - at * 60_000);
  const headline = `Headline of ${slug}`;
  return {
    providerMemberRef: slug,
    profileUrl,
    name,
    headline,
    reaction: "like",
    engagedAt,
    ...extra,
  };
}

/** A workspace of the organization "Acme Labs" with `allowance` credits, the ICP and the prices, a connected account and a source on a post the fake seeds. */
async function sourceOf(seeded: Engager[], allowance = 100) {
  const writer = asRole("billing_writer");
  const price = (action: string, credits: number, unit: string) =>
    writer.priceListEntry.createMany({
      data: {
        id: platform.newId(creditsIds.price_list_entry),
        ...{ action, credits, unit, version: 1, effectiveFrom: new Date(Date.now() - 60_000) },
      },
      skipDuplicates: true,
    });
  await price("signals.engager", 1, "engager");
  await price("signals.engager_read", 1, "engagers_30");
  await price("qualification.assessment", 0.2, "lead");
  const [tenant] = await tenancy.createTwoWorkspaces();
  const workspaceId: string = tenant.workspace.id;
  await db().organization.update({
    where: { id: tenant.organization.id },
    data: { name: "Acme Labs" },
  });
  await grantAllowance([tenant.organization.id], allowance);
  await inRun(workspaceId, async (tx) => {
    const { id } = (await readIcpForScoring(workspaceId)).icp;
    await tx.icp.update({ where: { id }, data: ICP });
  });
  const providerAccountRef = `fake-account-${randomUUID()}`;
  fake.emitWebhook("account.connected", providerAccountRef);
  const account = await linkedin.createConnectedAccount(workspaceId, { providerAccountRef });
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${Date.now()}${seeded.length}`;
  fake.seedPost(postUrl, seeded);
  const source = await db().signalSource.create({
    data: {
      id: platform.newId("src"),
      ...{ workspaceId, kind: "post_engagers", config: { postUrl }, label: "Launch post" },
      ...{ senderAccountId: account.id, createdBy: tenant.user.id },
    },
  });
  const organizationId: string = tenant.organization.id;
  return { workspaceId, organizationId, sourceId: source.id, accountId: account.id, postUrl };
}
type Source = Awaited<ReturnType<typeof sourceOf>>;
/** `amount` credits more for the source's organization: a second grant beside its allowance. */
async function topUp(source: Source, amount: number) {
  const writer = asRole("billing_writer");
  const grant = await writer.creditGrant.findFirstOrThrow({
    where: { organizationId: source.organizationId },
  });
  const id = platform.newId(creditsIds.credit_grant);
  await writer.creditGrant.create({ data: { ...grant, id, reason: "test_top_up", amount } });
}
type RunResult = { runId: string; status: string; code?: string };
type Activity = (input: never) => Promise<unknown>;
/** The triage's step decided by the rules: the model's answers here are qualification's. */
const rules = {
  signals_triage_candidates: async (input: never) => activities.signals_triage_fallback?.(input),
};
const run = (source: Source, replaced: Record<string, Activity> = {}) =>
  runWorkflow<RunResult>(
    "signals_run",
    { workspaceId: source.workspaceId, sourceId: source.sourceId },
    { activities: { ...activities, ...rules, ...replaced } },
  );
/** linkedin_read_profile, every attempt of the profile reads `failing` names (from 0) failing as an unreachable vendor does. */
function failingReads(failing: readonly number[]): Record<string, Activity> {
  const reads: string[] = [];
  const linkedin_read_profile = async (input: { requestKey: string }) => {
    if (!reads.includes(input.requestKey)) reads.push(input.requestKey);
    if (failing.includes(reads.indexOf(input.requestKey))) {
      const details = { method: "getProfile", reason: "unreachable" };
      fake.failNext(linkedinPort.errors.linkedin_provider_error, details);
    }
    return activities.linkedin_read_profile?.(input);
  };
  return { linkedin_read_profile };
}
/** The account's reads, each `[count, committed, status]`, and its profile reads' log, reservations too. */
async function readsOf(source: Source) {
  const where = { senderAccountId: source.accountId };
  const reservations = await db().senderQuotaReservation.findMany({ where });
  const logged = await db().senderActionLog.findMany({
    where: { ...where, kind: "read_profile" },
    orderBy: { id: "asc" },
  });
  return {
    reads: reservations.map(({ count, committed, status }) => [count, committed, status]),
    outcomes: logged.map((row) => row.outcome),
  };
}
/** The run's counts, and the workspace's events, evidence, persons, leads and outbox entries. */
async function stateOf(source: Source, runId: string) {
  const where = { workspaceId: source.workspaceId };
  const row = await db().signalRun.findUniqueOrThrow({ where: { id: runId } });
  const raw = await files.list({ ...where, prefix: `raw/signals/${runId}/` });
  return {
    counts: row.counts,
    candidates: await db().signalCandidate.count({ where: { runId } }),
    raw: raw.files.length,
    events: await db().signalEvent.findMany({ where, include: { evidence: true } }),
    persons: await db().person.findMany({ where, orderBy: { id: "asc" } }),
    leads: await db().lead.findMany({ where }),
    outbox: (name: string) => db().outboxEntry.findMany({ where: { ...where, eventName: name } }),
  };
}
/** The run's engager credits, each `[credits, status]`, oldest first: one per profile read. */
async function creditsOf(runId: string) {
  const usage = await db().creditUsage.findMany({
    where: { action: "signals.engager", idempotencyKey: { startsWith: `sigprof:${runId}:` } },
    orderBy: { id: "asc" },
  });
  return usage.map(({ credits, status }) => [credits.toFixed(), status]);
}
async function until<T>(read: () => Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    assert.ok(Date.now() < deadline, "until: nothing within thirty seconds");
    await sleep(50);
  }
}

test("twenty staged: two own staff, three hashed, five filtered by their country and ten kept, one of them with a title outside the ICP's (title-check-ai); ten persons, leads, events and evidence, five hashes with their reasons, fifteen profile reads, nothing else left of the rejected anywhere; signals.person_found's ten ids reach qualification's batch, which scores them", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const own = [0, 1].map((n) =>
    engager(`own-${n}`, n, undefined, { headline: "Sales at ACME Labs" }),
  );
  const hashed = [2, 3, 4].map((n) => engager(`hashed-${n}`, n));
  // A title outside the ICP's stops nobody (title-check-ai): the country does.
  const abroad = (n: number) => (n < 8 ? "Madrid, Spain" : "Paris, France");
  const filtered = [5, 6, 7, 8, 9].map((n) =>
    engager(`rejected-${n}`, n, { title: "Barista", locationText: abroad(n) }),
  );
  const comment = { reaction: "comment", commentText: `Exactly our problem. ${"x".repeat(600)}` };
  const kept = [...Array(10).keys()].map((n) =>
    engager(`kept-${n}`, 10 + n, n === 1 ? { title: "Barista" } : {}, n === 0 ? comment : {}),
  );
  const source = await sourceOf([...own, ...hashed, ...filtered, ...kept]);
  await inRun(source.workspaceId, async () => {
    for (const { providerMemberRef: providerId } of hashed) {
      await contacts.recordHash({
        providerId,
        kind: "rejected_candidate",
        dropReasons: ["title_mismatch"],
      });
    }
  });
  const result = await run(source);
  assert.equal(result.status, "done");
  const state = await stateOf(source, result.runId);
  assert.deepEqual(state.counts, {
    ...{ pages: 1, read: 20, staged: 20, created: 10, dropped_own: 2, dropped_hashed: 3 },
    ...{ dropped_filtered: 5, profiles_read: 15 },
  });
  assert.deepEqual([state.candidates, state.raw], [0, 0]);
  assert.equal(state.persons.length, 10);
  for (const { fieldProvenance } of state.persons) {
    const provenance = fieldProvenance as Record<string, { source: string }>;
    assert.equal(provenance.title?.source, "linkedin");
  }
  assert.deepEqual(
    state.leads.map((lead) => lead.sourceLabel),
    Array(10).fill("signal"),
  );
  // Each lead's source carries the signal source's label and post, which the lead list shows.
  type Named = { ref: string; label?: string; url?: string };
  const named = ({ sources }: { sources: unknown }) =>
    (sources as Named[]).map(({ ref, label, url }) => [ref, label, url]);
  assert.deepEqual(
    state.leads.map(named),
    Array(10).fill([[source.sourceId, "Launch post", source.postUrl]]),
  );
  assert.equal(state.events.length, 10);
  const evidence = state.events.flatMap((event) => event.evidence);
  assert.equal(evidence.length, 10);
  assert.deepEqual(
    evidence
      .map((row) => row.excerpt?.length ?? 0)
      .sort((a, b) => b - a)
      .slice(0, 2),
    [500, 0],
  );
  const hashes = await db().personHash.findMany({ where: { workspaceId: source.workspaceId } });
  const reasons = hashes.map((row) => JSON.stringify(row.dropReasons)).sort();
  assert.deepEqual(reasons, [
    ...Array(5).fill('{"country_mismatch":1}'),
    ...Array(3).fill('{"title_mismatch":1}'),
  ]);
  const barista = state.persons.find((person) => person.title === "Barista");
  assert.ok(barista, "the Barista is a person");
  assert.equal(state.leads.filter((lead) => lead.personId === barista.id).length, 1);
  assert.equal(state.events.filter((event) => event.personId === barista.id).length, 1);
  const reads = await db().senderQuotaReservation.findMany({
    where: { senderAccountId: source.accountId },
  });
  assert.deepEqual(
    reads.map(({ count, committed, status }) => [count, committed, status]),
    Array(16).fill([1, 1, "committed"]),
  );
  const profileReads = await db().senderActionLog.count({
    where: { workspaceId: source.workspaceId, kind: "read_profile", outcome: "ok" },
  });
  assert.equal(profileReads, 15);
  // A credit per profile read, the filtered five's too; the own staff and the hashed, none.
  assert.deepEqual(await creditsOf(result.runId), Array(15).fill(["1", "committed"]));
  // No table holds a rejected candidate's name, URL or headline.
  const rejected = [...own, ...hashed, ...filtered].flatMap((e) => [
    e.name,
    e.profileUrl,
    e.headline,
  ]);
  const owner = asRole("owner");
  const tables = await owner.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = ${testDb.schema} AND table_type = 'BASE TABLE'`;
  for (const { name } of tables) {
    const rows = await owner.$queryRawUnsafe<{ row: string }[]>(
      `SELECT row_to_json(t)::text AS row FROM "${testDb.schema}"."${name}" t`,
    );
    for (const { row } of rows) {
      for (const text of rejected) assert.ok(!row.includes(text), `${name} holds ${text}`);
    }
  }
  const [found, ...more] = await state.outbox("signals.person_found");
  assert.equal(more.length, 0);
  const personIds = (found?.payload as { personIds: string[] }).personIds;
  assert.deepEqual(
    [...personIds].sort(),
    state.persons.map((person) => person.id),
  );

  llm.reset();
  llm.script(...personIds.map(() => answer()));
  const handOff = moduleLoaders.filter(
    ({ name }) => name === "signals" || name === "qualification",
  );
  const taskQueue = `test-${randomUUID()}`;
  const options = { modules: handOff, taskQueue, healthPort: 0, schedules: "off" } as const;
  const host = await start({ ...options, client: db(), log });
  try {
    const batch = env.client.workflow.getHandle(
      `qualification.batch:${source.workspaceId}:current`,
    );
    await until(() => batch.describe().catch(() => undefined));
    const scored = { selected: 10, filtered: 0, scored: 10, failed: 0, stopped: null };
    assert.deepEqual(await batch.result(), scored);
  } finally {
    await host.close();
  }
  linkedin.useClock(undefined);
});

test("a known person engaging again gets a second event, no second lead and a re-score request; the same engagement seen again is dropped before any read; a company page is dropped with no hash; the first evidence keeps its captured_at through it all and through a re-import of the person", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const page = "https://www.linkedin.com/company/blue-harbor";
  const company = { ...engager("blue-harbor", 1), profileUrl: page };
  const like = engager("known", 0, {});
  const source = await sourceOf([like, company]);
  const first = await run(source);
  const before = await stateOf(source, first.runId);
  assert.deepEqual(before.counts, {
    ...{ pages: 1, read: 2, staged: 2, created: 1, dropped_company: 1, profiles_read: 1 },
  });
  assert.deepEqual(await creditsOf(first.runId), [["1", "committed"]]);
  const [lead] = before.leads;
  const again = { reaction: "comment", commentText: "Same here", engagedAt: new Date() } as const;
  const comment: Engager = { ...like, ...again };
  fake.seedPost(source.postUrl, [comment, like, company]);
  const second = await run(source);
  const after = await stateOf(source, second.runId);
  assert.deepEqual(after.counts, {
    ...{
      pages: 1,
      read: 3,
      staged: 2,
      created: 0,
      dropped_known: 1,
      profiles_read: 1,
      attached: 1,
    },
  });
  assert.deepEqual(await creditsOf(second.runId), [["1", "committed"]]);
  assert.deepEqual(
    after.persons.map((person) => person.id),
    [lead?.personId],
  );
  assert.equal(after.events.length, 2);
  assert.equal(after.leads.length, 1);
  assert.equal(after.leads[0]?.firstSourceAt.getTime(), like.engagedAt.getTime());
  const requested = await after.outbox("qualification.rescore_requested");
  const payloads = requested.map((entry) => (entry.payload as { personIds: string[] }).personIds);
  assert.deepEqual(payloads, [[lead?.personId]]);
  assert.equal(await db().personHash.count({ where: { workspaceId: source.workspaceId } }), 0);
  const profileReads = await db().senderActionLog.count({
    where: { workspaceId: source.workspaceId, kind: "read_profile", outcome: "ok" },
  });
  assert.equal(profileReads, 2);
  // captured_at never moves (alpha-p10-020): the comment's evidence is a row of its own, the like's
  // keeps its time, and both keep theirs through a re-import, as discovery's import writes one.
  const captured = async () => {
    const rows = await db().evidence.findMany({ where: { workspaceId: source.workspaceId } });
    return new Map(rows.map((row) => [row.id, row.capturedAt.getTime()]));
  };
  const [liked] = before.events.flatMap((event) => event.evidence);
  const times = await captured();
  assert.equal(times.size, 2);
  assert.equal(times.get(liked?.id ?? ""), liked?.capturedAt.getTime());
  await inRun(source.workspaceId, async () => {
    const profile = { linkedinUrl: like.profileUrl, firstName: "Name", title: TITLE };
    const imported = { source: "import", provider: "csv", profile };
    const { person, created } = await contacts.upsertPersonFromSource(imported);
    assert.deepEqual([person.id, created], [lead?.personId, false]);
    const from = { kind: "imported", ref: "imp_1" };
    await contacts.createLeadForPerson({ personId: person.id, source: from });
  });
  assert.deepEqual(await captured(), times);
  linkedin.useClock(undefined);
});

test("the day's reading ended between profile reads (gamma-p5-040): with 22 reads left the run's budget of two reads the page and one profile, which is processed, and the run ends done with budget_reached, no credit held, its watermark kept; the next day's run drops that one as known and reads the other two", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf([0, 1, 2].map((n) => engager(`capped-${n}`, n, {})));
  const cap = (dailyReadCap: number) =>
    db().senderAccount.update({ where: { id: source.accountId }, data: { dailyReadCap } });
  await cap(22);
  const ended = await run(source);
  assert.equal(ended.status, "done");
  const first = await stateOf(source, ended.runId);
  assert.deepEqual(first.counts, {
    ...{ pages: 1, read: 3, staged: 3, created: 1, profiles_read: 1, budget_reached: 1 },
  });
  assert.equal(first.persons.length, 1);
  // The next candidate's credit comes after its slot: none is held at the end of the day's reads.
  const where = { workspaceId: source.workspaceId };
  const held = await db().creditUsage.count({ where: { ...where, status: "reserved" } });
  assert.equal(held, 0);
  assert.deepEqual(await creditsOf(ended.runId), [["1", "committed"]]);
  const kept = await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } });
  assert.equal(kept.watermark, null);

  linkedin.useClock(() => THURSDAY);
  await cap(100);
  const done = await run(source);
  assert.equal(done.status, "done");
  const state = await stateOf(source, done.runId);
  assert.deepEqual(state.counts, {
    ...{ pages: 1, read: 3, staged: 3, dropped_known: 1, created: 2, profiles_read: 2 },
  });
  assert.equal(state.persons.length, 3);
  const found = await state.outbox("signals.person_found");
  const sizes = found.map((entry) => (entry.payload as { personIds: string[] }).personIds.length);
  assert.deepEqual(sizes.sort(), [1, 2]);
  assert.deepEqual(await creditsOf(done.runId), Array(2).fill(["1", "committed"]));
  linkedin.useClock(undefined);
});

test("a run refused a candidate's credit releases its read, processes the profiles it read and paid for and keeps the watermark; the next run reads the pages again for nothing, drops what the first processed before any profile read, and reads the rest", async () => {
  linkedin.useClock(() => WEDNESDAY);
  // Newest first: two kept and one filtered among the first 100 engagers, two kept among the last 30;
  // the staff are dropped before any read. Four credits pay for the first four reads.
  const seeded = [...Array(130).keys()].map((n) => {
    if (n < 2 || n >= 128) return engager(`paid-${n}`, n, {});
    if (n === 2) return engager(`filtered-${n}`, n, { locationText: "Paris, France" });
    return engager(`staff-${n}`, n, undefined, { headline: "Acme Labs" });
  });
  const source = await sourceOf(seeded, 4);
  const failed = await run(source);
  assert.deepEqual(failed, { runId: failed.runId, status: "failed", code: "insufficient_credits" });
  const first = await stateOf(source, failed.runId);
  assert.deepEqual(first.counts, {
    ...{ pages: 6, read: 130, staged: 130, created: 3, dropped_own: 125 },
    ...{ dropped_filtered: 1, profiles_read: 4 },
  });
  assert.deepEqual([first.persons.length, first.candidates, first.raw], [3, 0, 0]);
  assert.deepEqual(await creditsOf(failed.runId), Array(4).fill(["1", "committed"]));
  // Six pages and four profiles read; the fifth candidate's slot released.
  const { reads } = await readsOf(source);
  assert.deepEqual(reads, [...Array(10).fill([1, 1, "committed"]), [1, null, "released"]]);
  const kept = await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } });
  assert.equal(kept.watermark, null);

  await topUp(source, 8);
  const done = await run(source);
  assert.equal(done.status, "done");
  const second = await stateOf(source, done.runId);
  assert.deepEqual(second.counts, {
    ...{ pages: 6, read: 130, staged: 130, created: 1, dropped_own: 125 },
    ...{ dropped_hashed: 1, dropped_known: 3, profiles_read: 1 },
  });
  assert.deepEqual([second.persons.length, second.events.length], [4, 4]);
  const hashes = await db().personHash.findMany({ where: { workspaceId: source.workspaceId } });
  assert.deepEqual(
    hashes.map((row) => row.dropReasons),
    [{ country_mismatch: 1 }],
  );
  const profileReads = await db().senderActionLog.count({
    where: { workspaceId: source.workspaceId, kind: "read_profile", outcome: "ok" },
  });
  assert.equal(profileReads, 5);
  // The 130 read again cost nothing: one credit, for the one profile read.
  assert.deepEqual(await creditsOf(done.runId), [["1", "committed"]]);
  const blocks = await db().creditUsage.count({ where: { action: "signals.engager_read" } });
  assert.equal(blocks, 0);
  const moved = await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } });
  assert.deepEqual(moved.watermark, { engagedAt: seeded[0]?.engagedAt.toISOString() });
  linkedin.useClock(undefined);
});

test("a profile the provider cannot read, in the middle: its read settled as made after three attempts, the candidate dropped_unread, the others leads, the run done", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf([0, 1, 2].map((n) => engager(`unread-${n}`, n, {})));
  const done = await run(source, failingReads([1]));
  assert.deepEqual(done, { runId: done.runId, status: "done" });
  const state = await stateOf(source, done.runId);
  assert.deepEqual(state.counts, {
    ...{ pages: 1, read: 3, staged: 3, created: 2, profiles_read: 2, dropped_unread: 1 },
  });
  assert.deepEqual([state.leads.length, state.candidates, state.raw], [2, 0, 0]);
  const { reads, outcomes } = await readsOf(source);
  assert.deepEqual(reads, Array(4).fill([1, 1, "committed"]));
  const failed = Array(3).fill("linkedin_provider_error");
  assert.deepEqual(outcomes, ["reserved", "ok", "reserved", ...failed, "reserved", "ok"]);
  assert.deepEqual(await creditsOf(done.runId), [
    ["1", "committed"],
    ["1", "released"],
    ["1", "committed"],
  ]);
  linkedin.useClock(undefined);
});

test("profiles the provider cannot read stop the reading at the third within the hour: its first failed attempt pauses the account until its next working day (linkedin's third error, distinct calls) and its next attempt is refused linkedin_rate_limited before the call; the profiles read before are leads, the run fails with that code and keeps the watermark", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf([...Array(8).keys()].map((n) => engager(`outage-${n}`, n, {})));
  // Reads 1 and 2 fail, each one call of three attempts; read 3 resets the count in a row; read 4's
  // first attempt is the third call failed within the hour, which pauses the account, so that its
  // second attempt is refused before the call; 5 to 7 are never read.
  const failed = await run(source, failingReads([1, 2, 4, 5, 6]));
  const code = "linkedin_rate_limited";
  assert.deepEqual(failed, { runId: failed.runId, status: "failed", code });
  const state = await stateOf(source, failed.runId);
  assert.deepEqual(state.counts, {
    ...{ pages: 1, read: 8, staged: 8, created: 2, profiles_read: 2, dropped_unread: 2 },
  });
  assert.deepEqual([state.leads.length, state.candidates, state.raw], [2, 0, 0]);
  const { reads, outcomes } = await readsOf(source);
  assert.deepEqual(reads, Array(6).fill([1, 1, "committed"]));
  const three = Array(3).fill("linkedin_provider_error");
  assert.deepEqual(outcomes, [
    ...["reserved", "ok", "reserved", ...three, "reserved", ...three],
    ...["reserved", "ok", "reserved", "linkedin_provider_error"],
  ]);
  const account = await db().senderAccount.findUniqueOrThrow({ where: { id: source.accountId } });
  assert.ok(account.retryAt !== null && account.retryAt > WEDNESDAY, "paused");
  const events = await db().senderHealthEvent.findMany({ where: { senderId: source.accountId } });
  assert.deepEqual(
    events.map((event) => [event.trigger, event.metrics]),
    [["rate_limit_errors", { errors: 3, windowMinutes: 60 }]],
  );
  // Reads 0 and 3 paid, the three unreadable released, 5 to 7 never reserved.
  const paid = (n: number) => (n === 0 || n === 3 ? "committed" : "released");
  const credits = [0, 1, 2, 3, 4].map((n) => ["1", paid(n)]);
  assert.deepEqual(await creditsOf(failed.runId), credits);
  const kept = await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } });
  assert.equal(kept.watermark, null);
  linkedin.useClock(undefined);
});

test("a stop thrown between the last candidate's reservation and its profile read: the read refused account_stopped before its call, settled as made with its credit released; the profiles read before are leads, the run fails with that code and keeps the watermark (beta-p6-040)", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf([0, 1, 2].map((n) => engager(`stopped-${n}`, n, {})));
  const reads: string[] = [];
  const linkedin_read_profile = async (input: { requestKey: string }) => {
    if (!reads.includes(input.requestKey)) reads.push(input.requestKey);
    if (reads.indexOf(input.requestKey) === 2) {
      await linkedin.setAccountPaused(source.accountId, "tester");
    }
    return activities.linkedin_read_profile?.(input);
  };
  const failed = await run(source, { linkedin_read_profile });
  const code = "account_stopped";
  assert.deepEqual(failed, { runId: failed.runId, status: "failed", code });
  const state = await stateOf(source, failed.runId);
  assert.deepEqual(state.counts, {
    ...{ pages: 1, read: 3, staged: 3, created: 2, profiles_read: 2 },
  });
  assert.deepEqual([state.leads.length, state.candidates, state.raw], [2, 0, 0]);
  // The page and the three profile reads settled as made; the stopped one made no call, so no row.
  const { reads: slots, outcomes } = await readsOf(source);
  assert.deepEqual(slots, Array(4).fill([1, 1, "committed"]));
  assert.deepEqual(outcomes, ["reserved", "ok", "reserved", "ok", "reserved"]);
  assert.deepEqual(await creditsOf(failed.runId), [
    ["1", "committed"],
    ["1", "committed"],
    ["1", "released"],
  ]);
  const kept = await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } });
  assert.equal(kept.watermark, null);
  linkedin.useClock(undefined);
});

test("by the rules, recruiters, job seekers and a competitor's staff are dropped by their headline before any read slot, credit or profile read, and a competitor's staff by their profile after it, before the hard filters and with no hash; a talent acquisition lead's profile is a pending lead (signals-triage-ai); an ICP whose titles hold Recruiter keeps recruiters (gamma-p5-030)", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const rival = {
    companyName: "Rival Corp",
    companyUrl: "https://www.linkedin.com/company/rival-corp",
  };
  const source = await sourceOf([
    engager("noise-recruiter", 0, undefined, { headline: "Technical Recruiter | SaaS" }),
    engager("noise-seeker", 1, undefined, { headline: "Open to work" }),
    engager("noise-rival", 2, undefined, { headline: "AE at Rival Corp" }),
    engager("noise-rival-staff", 3, rival),
    engager("noise-talent", 4, { title: "Talent Acquisition Lead" }),
    engager("noise-kept", 5, {}),
  ]);
  const { senderAccountId, createdBy } = await db().signalSource.findUniqueOrThrow({
    where: { id: source.sourceId },
  });
  // gamma-p5-025's kind, its row written directly: a disabled source names a competitor too.
  await db().signalSource.create({
    data: {
      id: platform.newId("src"),
      ...{ workspaceId: source.workspaceId, kind: "competitor_engagement", config: rival },
      ...{ label: "Rival", senderAccountId, createdBy, enabled: false },
    },
  });
  const result = await run(source);
  assert.equal(result.status, "done");
  const state = await stateOf(source, result.runId);
  assert.deepEqual(state.counts, {
    ...{ pages: 1, read: 6, staged: 6, created: 2, profiles_read: 3 },
    ...{ dropped_recruiter: 1, dropped_job_seeker: 1, dropped_competitor: 2 },
  });
  assert.deepEqual([state.persons.length, state.candidates, state.raw], [2, 0, 0]);
  // The page and three profile reads, each with its credit: the headline's three reserved nothing.
  const { reads, outcomes } = await readsOf(source);
  assert.deepEqual(reads, Array(4).fill([1, 1, "committed"]));
  assert.deepEqual(outcomes, Array(3).fill(["reserved", "ok"]).flat());
  assert.deepEqual(await creditsOf(result.runId), Array(3).fill(["1", "committed"]));
  // The talent lead's title holds a recruiter's term: no rule drops it after the read any more, and
  // its country fits, so it is a pending lead, which the assessment judges; no hash.
  const talent = state.persons.find((person) => person.title === "Talent Acquisition Lead");
  assert.ok(talent, "the talent acquisition lead is a person");
  const pending = state.leads.filter((lead) => lead.personId === talent.id);
  assert.deepEqual(
    pending.map((lead) => lead.qualificationStatus),
    ["pending"],
  );
  assert.equal(await db().personHash.count({ where: { workspaceId: source.workspaceId } }), 0);

  const wanted = await sourceOf([
    engager("noise-wanted", 0, { title: "Recruiter" }, { headline: "Recruiter" }),
  ]);
  await inRun(wanted.workspaceId, async (tx) => {
    const { id } = (await readIcpForScoring(wanted.workspaceId)).icp;
    await tx.icp.update({ where: { id }, data: { titles: [TITLE, "Recruiter"] } });
  });
  const kept = await run(wanted);
  const after = await stateOf(wanted, kept.runId);
  assert.deepEqual(after.counts, { pages: 1, read: 1, staged: 1, created: 1, profiles_read: 1 });
  linkedin.useClock(undefined);
});

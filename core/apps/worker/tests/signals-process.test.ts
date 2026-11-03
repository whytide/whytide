// signals' processing end to end (alpha-p8-030; core/modules/signals/README.md "Processing"), on the
// slice's Temporal and a schema of its database: the run of signals-run.test.ts, credits, linkedin and
// signals loaded from their builds by the worker's own loader, on the LinkedIn, files and LLM fakes,
// now with the cheap drops, a profile read per candidate left and the processing; then the hand-off
// through the worker host with qualification loaded: signals.person_found's ids start qualification's
// batch, which scores them on the LLM fake. linkedin's clock is a working Wednesday at 10:00 UTC. A
// profile the provider cannot read is skipped, and three in a row end the run (fix-profile-skip).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TenantClient } from "@whytide/db";
import type { Engager, LinkedinFake, LlmFake } from "@whytide/providers";

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
const { useHashSalt } = await built("contacts/dist/testing/index.js");
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

/** A workspace of the organization "Acme Labs" with `allowance` credits, the ICP and both prices, a connected account and a source on a post the fake seeds. */
async function sourceOf(seeded: Engager[], allowance = 10) {
  const writer = asRole("billing_writer");
  const price = (action: string, credits: number, unit: string) =>
    writer.priceListEntry.createMany({
      data: {
        id: platform.newId(creditsIds.price_list_entry),
        ...{ action, credits, unit, version: 1, effectiveFrom: new Date(Date.now() - 60_000) },
      },
      skipDuplicates: true,
    });
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
const run = (source: Source, replaced: Record<string, Activity> = {}) =>
  runWorkflow<RunResult>(
    "signals_run",
    { workspaceId: source.workspaceId, sourceId: source.sourceId },
    { activities: { ...activities, ...replaced } },
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
async function until<T>(read: () => Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    assert.ok(Date.now() < deadline, "until: nothing within thirty seconds");
    await sleep(50);
  }
}

test("twenty staged: two own staff, three hashed, five filtered and ten kept; ten persons, leads, events and evidence, five hashes with their reasons, fifteen profile reads, nothing else left of the rejected anywhere; signals.person_found's ten ids reach qualification's batch, which scores them", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const own = [0, 1].map((n) =>
    engager(`own-${n}`, n, undefined, { headline: "Sales at ACME Labs" }),
  );
  const hashed = [2, 3, 4].map((n) => engager(`hashed-${n}`, n));
  const filtered = [5, 6, 7, 8, 9].map((n) =>
    engager(`rejected-${n}`, n, n < 8 ? { title: "Barista" } : { locationText: "Paris, France" }),
  );
  const comment = { reaction: "comment", commentText: `Exactly our problem. ${"x".repeat(600)}` };
  const kept = [...Array(10).keys()].map((n) =>
    engager(`kept-${n}`, 10 + n, {}, n === 0 ? comment : {}),
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
    ...Array(2).fill('{"country_mismatch":1}'),
    ...Array(6).fill('{"title_mismatch":1}'),
  ]);
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

test("the cap reached between profile reads: the profiles read are processed before the run waits, and it reads the rest once the quota day rolls", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf([0, 1, 2].map((n) => engager(`capped-${n}`, n, {})));
  await db().senderAccount.update({ where: { id: source.accountId }, data: { dailyReadCap: 2 } });
  const pending = run(source);
  // The page and one profile read on Wednesday: that one's person exists before the day rolls.
  const where = { workspaceId: source.workspaceId };
  await until(async () => ((await db().person.count({ where })) === 1 ? true : undefined));
  linkedin.useClock(() => THURSDAY);
  const done = await pending;
  assert.equal(done.status, "done");
  const state = await stateOf(source, done.runId);
  assert.deepEqual(state.counts, {
    ...{ pages: 1, read: 3, staged: 3, created: 3, profiles_read: 3 },
  });
  const found = await state.outbox("signals.person_found");
  const sizes = found.map((entry) => (entry.payload as { personIds: string[] }).personIds.length);
  assert.deepEqual(sizes.sort(), [1, 2]);
  linkedin.useClock(undefined);
});

test("a run refused its next block processes the pages it read and paid for and keeps the watermark; the next run reads and pays for them again, drops what the first processed before any profile read, and processes the older engagers", async () => {
  linkedin.useClock(() => WEDNESDAY);
  // Newest first: two kept and one filtered among the first 100 engagers, two kept among the last 30.
  const seeded = [...Array(130).keys()].map((n) => {
    if (n < 2 || n >= 128) return engager(`paid-${n}`, n, {});
    if (n === 2) return engager(`filtered-${n}`, n, { title: "Barista" });
    return engager(`staff-${n}`, n, undefined, { headline: "Acme Labs" });
  });
  const source = await sourceOf(seeded, 4);
  const failed = await run(source);
  assert.deepEqual(failed, { runId: failed.runId, status: "failed", code: "insufficient_credits" });
  const first = await stateOf(source, failed.runId);
  assert.deepEqual(first.counts, {
    ...{ pages: 4, read: 100, staged: 100, created: 2, dropped_own: 97 },
    ...{ dropped_filtered: 1, profiles_read: 3 },
  });
  assert.deepEqual([first.persons.length, first.candidates], [2, 0]);
  const kept = await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } });
  assert.equal(kept.watermark, null);

  await topUp(source, 8);
  const done = await run(source);
  assert.equal(done.status, "done");
  const second = await stateOf(source, done.runId);
  assert.deepEqual(second.counts, {
    ...{ pages: 6, read: 130, staged: 130, created: 2, dropped_own: 125 },
    ...{ dropped_hashed: 1, dropped_known: 2, profiles_read: 2 },
  });
  assert.deepEqual([second.persons.length, second.events.length], [4, 4]);
  const hashes = await db().personHash.findMany({ where: { workspaceId: source.workspaceId } });
  assert.deepEqual(
    hashes.map((row) => row.dropReasons),
    [{ title_mismatch: 1 }],
  );
  const profileReads = await db().senderActionLog.count({
    where: { workspaceId: source.workspaceId, kind: "read_profile", outcome: "ok" },
  });
  assert.equal(profileReads, 5);
  // The 130 read again are paid again: 4 credits on the first block, 1 on the second.
  const usage = await db().creditUsage.findMany({ where: { subjectRef: done.runId } });
  const paid = usage.filter((row) => row.status === "committed").map((row) => Number(row.credits));
  assert.deepEqual(paid.sort(), [1, 4]);
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
  linkedin.useClock(undefined);
});

test("three profiles in a row the provider cannot read stop the reading: the profiles read before them are leads, the run fails linkedin_provider_error and keeps the watermark; a profile read between two resets the count", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf([...Array(8).keys()].map((n) => engager(`outage-${n}`, n, {})));
  // Read 3 between two unreadable ones resets the count; reads 4 to 6 stop it; 7 is never read.
  const failed = await run(source, failingReads([1, 2, 4, 5, 6]));
  const code = "linkedin_provider_error";
  assert.deepEqual(failed, { runId: failed.runId, status: "failed", code });
  const state = await stateOf(source, failed.runId);
  assert.deepEqual(state.counts, {
    ...{ pages: 1, read: 8, staged: 8, created: 2, profiles_read: 2, dropped_unread: 5 },
  });
  assert.deepEqual([state.leads.length, state.candidates, state.raw], [2, 0, 0]);
  const { reads } = await readsOf(source);
  assert.deepEqual(reads, Array(8).fill([1, 1, "committed"]));
  const kept = await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } });
  assert.equal(kept.watermark, null);
  linkedin.useClock(undefined);
});

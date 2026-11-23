// qualification's batch end to end (alpha-p6-040; core/modules/qualification/README.md "The
// batch"), on the slice's Temporal and a schema of its database: qualification loaded from its
// build by the worker's own loader, its activities through the host's wrapper, the LLM fake
// scripted per lead as its assessment starts, credits' client bound on the test's schema; the
// batch's robustness (alpha-p10-100): the provider's failures tried again, other failures failing
// the batch, a lease that ran out, a decided lead kept without credits, the tick's skips and
// failures; last, the worker host itself, from discovery's import event in the outbox, and the
// tick's schedule; the re-score after a criteria save, and from the route's request through the
// host. Contacts, icp, tenancy and qualification's code and test helpers come from their builds,
// the files the loader's modules import. The replay of the recorded histories is `pnpm -F worker
// test:replay`. A fake signal reader gives every decision a known intent, so a lead's tier is its
// priority's (gamma-p5-060), as in production, where signals' reader is always registered. Last, a
// batch over two audiences (gamma-p5-050): each lead against its agent's audience, with its own
// excerpts, which reach neither the workflow's history nor a log line.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TenantClient } from "@whytide/db";
import type { WorkflowStart } from "@whytide/platform";
import type { LlmFake } from "@whytide/providers";

// The LLM fake whatever the environment names: the providers' config reads it as it loads, below.
process.env.PROVIDER_LLM = "fake";

const { loadAgentTasks } = await import("@whytide/ai");
const { ids: creditIds } = await import("@whytide/credits");
const { createCreditsClient, grantAllowance } = await import("@whytide/credits/testing");
const { outboxWriter, withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { getAdapter, llmPort } = await import("@whytide/providers");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { start } = await import("../src/start.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useEnrichmentHold, useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { events: discovery } = await import(built("discovery/dist/index.js"));
const { createPlaybook } = await import(built("playbooks/dist/testing/index.js"));
const { readIcpForScoring } = await import(built("icp/dist/index.js"));
const {
  batchStart,
  errors: qualificationErrors,
  ids: qualificationIds,
} = await import(built("qualification/dist/index.js"));
const { requestRescore } = await import(built("qualification/dist/domain/rescore.js"));
const { useQualificationClient, useSignalReader } = await import(
  built("qualification/dist/testing/index.js")
);
const { useTenancyClient } = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const env = withTestWorkflowEnvironment();
const app = () => asRole("app");
useHashSalt("test-salt-".repeat(4));
// A new lead is judged at once here; contacts' enrichment-hold.test.ts holds one (gamma-en-040).
useEnrichmentHold(0);
useQualificationClient(app());
useTenancyClient(app());
platform.bindCreditsClient(createCreditsClient());
await loadAgentTasks();
const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
const qualification = moduleLoaders.filter(({ name }) => name === "qualification");
const loaded = await loadModules(qualification);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: app(), log })];
  }),
);
/** Per person, the fake's answer, scripted as the person's assessment starts. */
const scripts = new Map<string, () => void>();
const assess = activities.qualification_assess as (input: unknown) => Promise<unknown>;
const scripted = {
  ...activities,
  qualification_assess: (input: { personId: string }) => {
    scripts.get(input.personId)?.();
    return assess(input);
  },
};
/** qualification_assess failing with the module's `code`, through the host's wrapper. */
const failing = (code: string) => {
  const definition = loaded.activities.get("qualification_assess");
  if (definition === undefined) throw new Error("qualification_assess is not loaded");
  const run = async () => {
    throw new platform.AppError(qualificationErrors[code]);
  };
  return hostActivity("qualification_assess", { ...definition, run }, { client: app(), log });
};
/** The code of the activity failure that failed a workflow. */
const codeOf = (error: unknown) =>
  (error as { cause?: { cause?: { type?: string } } }).cause?.cause?.type;

const ACTION = "qualification.assessment";
const principal = platform.servicePrincipal("test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app() });
const ICP = {
  titles: ["Head of Revenue Operations", "VP Sales"],
  seniorities: ["head", "vp"],
  industries: ["Software"],
  sizeRanges: ["51-200", "201-500"],
  countries: ["DE", "AT"],
  mustHaves: "Runs a sales team on a CRM",
  disqualifiers: "Agencies and freelancers",
};
const COMPANY = { name: "Blue Harbor Labs", domain: "blueharbor.example", industry: "Software" };
const TITLE = "Head of Revenue Operations";
type Verdict = { criterion: string; verdict: string; evidence: string };
const VERDICTS: Verdict[] = [
  { criterion: "title_function", verdict: "met", evidence: TITLE },
  { criterion: "seniority", verdict: "met", evidence: TITLE },
  { criterion: "company_size", verdict: "met", evidence: "51-200" },
  { criterion: "industry", verdict: "met", evidence: "Software" },
  { criterion: "location", verdict: "met", evidence: "Germany (DE)" },
  { criterion: "must_haves", verdict: "unknown", evidence: "" },
];
/** The model's answer: every verdict quotes the lead's data; `changed` overrides some verdicts. */
const answer = (changed: Record<string, string> = {}, disqualifiers: string[] = []) => ({
  verdicts: VERDICTS.map((v) => ({ ...v, verdict: changed[v.criterion] ?? v.verdict })),
  disqualifiers,
  summary: "A revenue operations head at a software company.",
});
/**
 * Every person's signals, in place of signals' reader, which the @whytide/credits import registers
 * as the worker host's modules always do: two topics' posts commented on, rated fully relevant and
 * dated as the decision reads them, so neither decays; their creator unknown, so the alert of a
 * lead entering Hot mails nobody (owner_unknown). intent-v1 (qualification README "Intent and
 * priority") makes S = 5 + 5 = 10, with no stacking (one kind) and no boost (a weight under 6): an
 * intent of round(100 × (1 − e^(−10 ÷ 8))) = 71. A lead's tier is its priority's,
 * round(0.55 × fit + 0.45 × 71): answer()'s fit of 88 is 80, hot; 82, its location unknown too, 77,
 * hot; 74, once must_haves weighs 60, 73, warm.
 */
const reader = {
  intentInputs: async ({ personIds }: { personIds: readonly string[] }) =>
    personIds.flatMap((personId) =>
      ["src_1", "src_2"].map((sourceId) => ({
        ...{ personId, sourceId, eventId: `evt_${personId}_${sourceId}`, count: 1 },
        ...{ kind: "topic_engagement", role: "comment", relevance: 1, intentClass: "other" },
        ...{ occurredAt: new Date(), ownerUserId: null },
      })),
    ),
  excerpts: async () => [],
};
useSignalReader(reader);

/**
 * A workspace of its own organization with `allowance` credits, the price listed, the ICP at
 * version 1, whose id, the default audience's, it gives too; its id starts with `prefix`, which
 * orders the tick's list.
 */
async function workspaceWith(allowance: number, prefix = "wsp") {
  const organizationId = `org_${randomUUID()}`;
  const workspaceId = `${prefix}_${randomUUID()}`;
  await app().organization.create({
    data: { id: organizationId, name: "Org", slug: organizationId },
  });
  const workspace = { id: workspaceId, organizationId, name: "Workspace", slug: "workspace" };
  await app().workspace.create({ data: workspace });
  await grantAllowance([organizationId], allowance);
  await asRole("billing_writer").priceListEntry.upsert({
    where: { action_version: { action: ACTION, version: 1 } },
    create: {
      id: platform.newId(creditIds.price_list_entry),
      ...{ action: ACTION, credits: 0.2, unit: "lead", version: 1, effectiveFrom: new Date() },
    },
    update: {},
  });
  const icpId: string = await inRun(workspaceId, async (tx) => {
    const { id } = (await readIcpForScoring(workspaceId)).icp;
    await tx.icp.update({ where: { id }, data: ICP });
    return id;
  });
  return { organizationId, workspaceId, icpId };
}
/**
 * A pending lead with its company; `profile` changes the person, as a filter's miss; imported
 * unless `source` names a signal source.
 */
function leadOf(
  workspaceId: string,
  slug: string,
  profile: Record<string, string> = {},
  source: { kind: string; ref: string } = { kind: "imported", ref: "imp_1" },
) {
  return inRun(workspaceId, async () => {
    const person = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const values = { ...person, title: TITLE, locationText: "Berlin, Germany", ...profile };
    const imported = { source: "import", provider: "csv" };
    const { person: stored } = await contacts.upsertPersonFromSource({
      ...imported,
      profile: values,
    });
    const company = { ...COMPANY, sizeRange: "51-200" };
    const { company: linked } = await contacts.upsertCompany({ ...imported, company });
    await contacts.linkPersonToCompany({ personId: stored.id, companyId: linked.id });
    await contacts.createLeadForPerson({ personId: stored.id, source });
    return stored.id as string;
  });
}
const batch = (workspaceId: string) =>
  runWorkflow("qualification_batch", { workspaceId }, { activities: scripted });
const leads = async (workspaceId: string) => {
  const orderBy = [{ createdAt: "asc" }, { personId: "asc" }] as const;
  const rows = await app().lead.findMany({ where: { workspaceId }, orderBy: [...orderBy] });
  return rows.map((row) => ({
    status: row.qualificationStatus,
    tier: row.tier,
    reason: row.hardFilterReason ?? row.statusReason,
    icpVersion: row.icpVersionScored,
  }));
};
const usages = (workspaceId: string) =>
  app().creditUsage.findMany({
    where: { workspaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
const balance = (workspaceId: string) =>
  inRun(workspaceId, () => platform.credits.balance(workspaceId));
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

test("a batch of ten pending leads ends each as scripted; reservations committed for the stored snapshots and released for ai_failed and the provider's failure, 0.2 per scored lead; one qualification.lead_qualified per decided lead", async () => {
  const { workspaceId, icpId } = await workspaceWith(10);
  const ids: string[] = [];
  const plan: [Record<string, string>, (() => void) | undefined][] = [
    // A title outside the ICP's no filter stops (title-check-ai): the country does.
    [{ title: "Barista", locationText: "Madrid, Spain" }, undefined],
    [{}, () => fake.script(answer())],
    [{}, () => fake.script(answer({}, ["recruiter"]))],
    [{}, () => fake.script(answer({ location: "unknown" }))],
    [{}, () => fake.script(answer())],
    [{ locationText: "Paris, France" }, undefined],
    [
      {},
      () =>
        fake.script(answer({ seniority: "not_met", company_size: "not_met", industry: "not_met" })),
    ],
    [{}, () => fake.script(answer())],
    [{}, () => fake.script(answer({}, ["bad_vibes"]), answer({}, ["bad_vibes"]))],
    [{}, () => fake.failNext("llm_invalid_key")],
  ];
  for (const [at, [profile, script]] of plan.entries()) {
    const id = await leadOf(workspaceId, `lead-${at}`, profile);
    if (script) scripts.set(id, script);
    ids.push(id);
  }
  fake.reset();
  const result = { selected: 10, filtered: 2, scored: 6, failed: 2, stopped: "provider_failed" };
  assert.deepEqual(await batch(workspaceId), result);
  const decided = (status: string, tier: string | null, reason: string | null = null) => {
    return { status, tier, reason, icpVersion: 1 };
  };
  assert.deepEqual(await leads(workspaceId), [
    decided("hard_filtered", null, "country_mismatch"),
    decided("qualified", "hot"),
    decided("not_qualified", null, "recruiter"),
    decided("needs_review", "hot"),
    decided("qualified", "hot"),
    decided("hard_filtered", null, "country_mismatch"),
    decided("not_qualified", null),
    decided("qualified", "hot"),
    decided("ai_failed", null, "invalid"),
    // The provider's failure: tried again at a later batch, the lead waits meanwhile.
    { status: "pending", tier: null, reason: "provider_failed", icpVersion: null },
  ]);
  const filtered = await app().lead.findFirstOrThrow({ where: { personId: ids[5] } });
  const params = { reason: "country_mismatch", value: "FR", icp: "DE, AT" };
  assert.deepEqual(filtered.why, [{ key: "qualification.why.hard_filtered", params }]);

  const assessed = [1, 2, 3, 4, 6, 7, 8, 9].map((at) => ids[at]);
  const reserved = await usages(workspaceId);
  assert.deepEqual(
    reserved.map((usage) => [usage.subjectRef, usage.status, usage.idempotencyKey]),
    assessed.map((id, at) => [
      id,
      at < 6 ? "committed" : "released",
      `qual:${id}:${icpId}:1:fake-model:2`,
    ]),
  );
  const wallet = await balance(workspaceId);
  assert.deepEqual([wallet.committed, wallet.reserved, wallet.available], ["1.2", "0", "8.8"]);

  const where = { eventName: "qualification.lead_qualified" };
  const outbox = await app().outboxEntry.findMany({ where });
  const statuses = (await leads(workspaceId)).map(({ status, tier }) => ({ status, tier }));
  const byPerson = (a: { personId: string }, b: { personId: string }) =>
    a.personId < b.personId ? -1 : 1;
  const decidedIds = ids.slice(0, 9);
  assert.deepEqual(
    outbox.map(({ payload }) => payload as { personId: string }).sort(byPerson),
    decidedIds.map((personId, at) => ({ workspaceId, personId, ...statuses[at] })).sort(byPerson),
  );
});

test("the batch's steps run again make no model call and no new reservation; a second batch selects none; a targeting change re-assesses at the new version", async () => {
  const { workspaceId, icpId } = await workspaceWith(10);
  const ids = [await leadOf(workspaceId, "again-1"), await leadOf(workspaceId, "again-2")];
  fake.reset();
  fake.script(answer(), answer());
  assert.deepEqual(await batch(workspaceId), {
    selected: 2,
    ...{ filtered: 0, scored: 2, failed: 0, stopped: null },
  });
  const [first] = await usages(workspaceId);
  const calls = fake.recordedCalls.length;

  // As a retried activity runs them: the stored reservation, the cached answer, the same commit.
  const context = {
    workspaceId,
    workflowId: `qualification.batch:${workspaceId}:current`,
    attempt: 2,
    tenant: <T>(fn: (tx: TenantClient) => Promise<T>) => inRun(workspaceId, fn),
  };
  const step = (name: string, input: object) =>
    loaded.activities.get(name)?.run({ workspaceId, ...input } as never, context as never);
  const lead = { personId: ids[0], icpId, icpVersion: 1 };
  const again = (await step("qualification_reserve", lead)) as { usageId: string };
  assert.deepEqual(again, { status: "reserved", usageId: first?.id, attempt: 1 });
  const snapshot = (await step("qualification_assess", lead)) as { snapshotId: string };
  const stored = await app().lead.findFirstOrThrow({ where: { personId: ids[0] } });
  assert.deepEqual(snapshot, { status: "assessed", snapshotId: stored.currentScoreSnapshotId });
  const held = { ...lead, usageId: again.usageId, snapshotId: snapshot.snapshotId };
  assert.deepEqual(await step("qualification_commit", held), { status: "committed" });
  assert.deepEqual(await batch(workspaceId), {
    selected: 0,
    ...{ filtered: 0, scored: 0, failed: 0, stopped: null },
  });
  assert.equal(fake.recordedCalls.length, calls);
  assert.equal((await usages(workspaceId)).length, 2);
  assert.equal((await balance(workspaceId)).committed, "0.4");

  await inRun(workspaceId, (tx) =>
    tx.icp.updateMany({ data: { titles: [...ICP.titles, "Head of Sales"], version: 2 } }),
  );
  fake.script(answer(), answer());
  assert.deepEqual(await batch(workspaceId), {
    selected: 2,
    ...{ filtered: 0, scored: 2, failed: 0, stopped: null },
  });
  assert.equal(fake.recordedCalls.length, calls + 2);
  assert.deepEqual(
    (await leads(workspaceId)).map(({ status, icpVersion }) => [status, icpVersion]),
    [
      ["qualified", 2],
      ["qualified", 2],
    ],
  );
  assert.equal((await balance(workspaceId)).committed, "0.8");
});

test("below 0.2 credits the lead waits insufficient_credits with no model call; the next batch after a grant assesses it; out of credits again, at a new ICP version, it keeps its decision", async () => {
  const { organizationId, workspaceId } = await workspaceWith(0.1);
  const id = await leadOf(workspaceId, "poor-1");
  fake.reset();
  const stopped = { selected: 1, filtered: 0, scored: 0, failed: 0 };
  assert.deepEqual(await batch(workspaceId), { ...stopped, stopped: "insufficient_credits" });
  assert.deepEqual(await leads(workspaceId), [
    { status: "pending", tier: null, reason: "insufficient_credits", icpVersion: null },
  ]);
  assert.deepEqual([fake.recordedCalls.length, (await usages(workspaceId)).length], [0, 0]);

  const billing = asRole("billing_writer");
  const subscription = await billing.subscription.findFirstOrThrow({ where: { organizationId } });
  const { id: subscriptionId, periodStart, periodEnd } = subscription;
  const grant = {
    organizationId,
    subscriptionId,
    amount: 0.1,
    reason: "top_up",
    periodStart,
    periodEnd,
  };
  await billing.creditGrant.create({
    data: { id: platform.newId(creditIds.credit_grant), ...grant },
  });
  scripts.set(id, () => fake.script(answer()));
  const scored = { selected: 1, filtered: 0, scored: 1, failed: 0, stopped: null };
  assert.deepEqual(await batch(workspaceId), scored);
  assert.deepEqual((await leads(workspaceId))[0], {
    status: "qualified",
    tier: "hot",
    reason: null,
    icpVersion: 1,
  });
  assert.equal((await balance(workspaceId)).committed, "0.2");

  const titles = [...ICP.titles, "Head of Sales"];
  await inRun(workspaceId, (tx) => tx.icp.updateMany({ data: { titles, version: 2 } }));
  assert.deepEqual(await batch(workspaceId), { ...stopped, stopped: "insufficient_credits" });
  assert.deepEqual((await leads(workspaceId))[0], {
    status: "qualified",
    tier: "hot",
    reason: null,
    icpVersion: 1,
  });
});

test("title-check-ai: a title outside the ICP's titles is assessed and a country miss is still hard_filtered; the leads a retired rule decided are assessed again once, under prompt v2: title_mismatch pending again, then decided, and a v1 snapshot not_qualified for agency_or_consultant; country_mismatch and own_company stay", async () => {
  const { organizationId, workspaceId, icpId } = await workspaceWith(0.1);
  const titles = ["Revenue Operations Manager"];
  await inRun(workspaceId, (tx) => tx.icp.updateMany({ data: { titles } }));
  const combined = { title: "RevOps & GTM Lead" };
  const fresh = await leadOf(workspaceId, "combined-1", combined);
  const barista = await leadOf(workspaceId, "barista-1", { title: "Barista" });
  await leadOf(workspaceId, "combined-2", { ...combined, locationText: "Paris, France" });
  const paris = await leadOf(workspaceId, "paris-1", { locationText: "Paris, France" });
  const agency = await leadOf(workspaceId, "agency-1");
  const own = await leadOf(workspaceId, "own-1");
  // As an older release left them: the title filter's and the country filter's decisions, and
  // prompt v1's snapshots, not_qualified for agency_or_consultant and for own_company.
  await inRun(workspaceId, async (tx) => {
    for (const [personId, reason] of [
      [barista, "title_mismatch"],
      [paris, "country_mismatch"],
    ] as const) {
      const why = [{ key: "qualification.why.hard_filtered", params: { reason } }];
      await contacts.applyQualification({
        personId,
        status: "hard_filtered",
        reason,
        why,
        icpVersion: 1,
      });
    }
    for (const [personId, code] of [
      [agency, "agency_or_consultant"],
      [own, "own_company"],
    ] as const) {
      const id = platform.newId(qualificationIds.score_snapshot);
      const model = { modelId: "fake-model", promptVersion: 1, summary: "", disqualifiers: [code] };
      const outcome = { fitScore: 77, status: "not_qualified" as const };
      await tx.scoreSnapshot.create({
        data: {
          id,
          workspaceId,
          personId,
          icpVersion: 1,
          ...model,
          ...outcome,
          decisionRecordId: `dec_${code}`,
        },
      });
      const decision = { status: "not_qualified", fitScore: 77, snapshotId: id, reason: code };
      await contacts.applyQualification({ personId, ...decision, icpVersion: 1 });
    }
  });
  fake.reset();
  const stopped = { filtered: 1, scored: 0, failed: 0, stopped: "insufficient_credits" };
  assert.deepEqual(await batch(workspaceId), { selected: 4, ...stopped });
  const kept = (status: string, reason: string) => ({ status, tier: null, reason, icpVersion: 1 });
  const waiting = (reason: string | null) => ({
    status: "pending",
    tier: null,
    reason,
    icpVersion: null,
  });
  assert.deepEqual(await leads(workspaceId), [
    waiting("insufficient_credits"),
    waiting(null),
    kept("hard_filtered", "country_mismatch"),
    kept("hard_filtered", "country_mismatch"),
    kept("not_qualified", "agency_or_consultant"),
    kept("not_qualified", "own_company"),
  ]);
  assert.equal(fake.recordedCalls.length, 0);

  const billing = asRole("billing_writer");
  const subscription = await billing.subscription.findFirstOrThrow({ where: { organizationId } });
  const { id: subscriptionId, periodStart, periodEnd } = subscription;
  const grant = { organizationId, subscriptionId, amount: 0.6, reason: "top_up" };
  await billing.creditGrant.create({
    data: { id: platform.newId(creditIds.credit_grant), ...grant, periodStart, periodEnd },
  });
  /** answer() with its title and seniority verdicts quoting `title`. */
  const quoting = (title: string, verdict = "met") => {
    const base = answer({ title_function: verdict });
    const named = ["title_function", "seniority"];
    const verdicts = base.verdicts.map((v) =>
      named.includes(v.criterion) ? { ...v, evidence: title } : v,
    );
    return { ...base, verdicts };
  };
  scripts.set(fresh, () => fake.script(quoting("RevOps & GTM Lead")));
  scripts.set(barista, () => fake.script(quoting("Barista", "not_met")));
  scripts.set(agency, () => fake.script(answer()));
  const scored = { selected: 3, filtered: 0, scored: 3, failed: 0, stopped: null };
  assert.deepEqual(await batch(workspaceId), scored);
  const decisions = (await leads(workspaceId)).map(({ status, reason }) => [status, reason]);
  assert.deepEqual(decisions, [
    ["qualified", null],
    ["not_qualified", null],
    ["hard_filtered", "country_mismatch"],
    ["hard_filtered", "country_mismatch"],
    ["qualified", null],
    ["not_qualified", "own_company"],
  ]);
  assert.equal(fake.recordedCalls.length, 3);
  const keys = (await usages(workspaceId)).map((usage) => [usage.idempotencyKey, usage.status]);
  const v2 = [fresh, barista, agency].map((id) => [
    `qual:${id}:${icpId}:1:fake-model:2`,
    "committed",
  ]);
  assert.deepEqual(keys, v2);
  const snapshots = await app().scoreSnapshot.findMany({
    where: { workspaceId, personId: { in: [agency, own] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(
    snapshots.map((row) => [row.personId, row.promptVersion, row.disqualifiers]),
    [
      [agency, 1, ["agency_or_consultant"]],
      [own, 1, ["own_company"]],
      [agency, 2, []],
    ],
  );

  const none = { selected: 0, filtered: 0, scored: 0, failed: 0, stopped: null };
  assert.deepEqual(await batch(workspaceId), none);
});

test("the provider's failure leaves the lead waiting for a later batch, reserved again under the next attempt's key; at the third attempt it is ai_failed", async () => {
  const { workspaceId, icpId } = await workspaceWith(1);
  const id = await leadOf(workspaceId, "flaky-1");
  scripts.set(id, () => fake.failNext("llm_invalid_key"));
  fake.reset();
  const failed = { selected: 1, filtered: 0, scored: 0, failed: 1, stopped: "provider_failed" };
  const waiting = { status: "pending", tier: null, reason: "provider_failed", icpVersion: null };
  for (const lead of [waiting, waiting, { ...waiting, status: "ai_failed", icpVersion: 1 }]) {
    assert.deepEqual(await batch(workspaceId), failed);
    assert.deepEqual(await leads(workspaceId), [lead]);
  }
  const key = `qual:${id}:${icpId}:1:fake-model:2`;
  assert.deepEqual(
    (await usages(workspaceId)).map((usage) => [usage.idempotencyKey, usage.status]),
    [key, `${key}:2`, `${key}:3`].map((each) => [each, "released"]),
  );
  const none = { selected: 0, filtered: 0, scored: 0, failed: 0, stopped: null };
  assert.deepEqual(await batch(workspaceId), none);
});

test("a failure that is not the provider's fails the batch and keeps the lead pending and reserved; past the 24-hour lease, the next batch releases that reservation and commits under the next attempt's key", async () => {
  const { workspaceId, icpId } = await workspaceWith(1);
  const id = await leadOf(workspaceId, "held-1");
  let now = new Date();
  platform.bindCreditsClient(createCreditsClient(() => now));
  try {
    const broken = { ...scripted, qualification_assess: failing("assessment_agent_not_loaded") };
    await assert.rejects(
      runWorkflow("qualification_batch", { workspaceId }, { activities: broken }),
      (error) => codeOf(error) === "assessment_agent_not_loaded",
    );
    const pending = { status: "pending", tier: null, reason: null, icpVersion: null };
    assert.deepEqual(await leads(workspaceId), [pending]);
    assert.deepEqual(
      (await usages(workspaceId)).map(({ status }) => status),
      ["reserved"],
    );

    now = new Date(now.getTime() + 25 * 3_600_000);
    scripts.set(id, () => fake.script(answer()));
    fake.reset();
    const scored = { selected: 1, filtered: 0, scored: 1, failed: 0, stopped: null };
    assert.deepEqual(await batch(workspaceId), scored);
    assert.equal((await leads(workspaceId))[0]?.status, "qualified");
    const key = `qual:${id}:${icpId}:1:fake-model:2`;
    assert.deepEqual(
      (await usages(workspaceId)).map((usage) => [usage.idempotencyKey, usage.status]),
      [
        [key, "released"],
        [`${key}:2`, "committed"],
      ],
    );
  } finally {
    platform.bindCreditsClient(createCreditsClient());
  }
});

test("the tick starts the batch of every workspace with a lead to assess and a saved ICP, one at a time by qualification.batch:<workspace>:current; one that fails leaves the others started and fails the tick with its code", async () => {
  // The broken workspace comes first in the tick's list, before the busy one.
  const [broken, busy, idle, unsaved] = [
    (await workspaceWith(1, "wsp_a")).workspaceId,
    (await workspaceWith(1, "wsp_b")).workspaceId,
    (await workspaceWith(1, "wsp_b")).workspaceId,
    (await workspaceWith(1, "wsp_b")).workspaceId,
  ];
  for (const workspaceId of [busy, unsaved]) await leadOf(workspaceId, "tick-1");
  const empty = { titles: [], seniorities: [], industries: [], sizeRanges: [], countries: [] };
  const never = { ...empty, mustHaves: "", disqualifiers: "" };
  await inRun(unsaved, (tx) => tx.icp.updateMany({ data: never }));
  const starts: WorkflowStart[] = [];
  const unbind = platform.bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      if (request.input.workspaceId !== broken) return { started: true };
      throw new platform.AppError(platform.workflowErrors.workflows_not_bound);
    },
  });
  const tick = () => runWorkflow("qualification_batch_tick", {}, { activities });
  try {
    const counts = await tick();
    assert.deepEqual(counts, { workspaces: 4, started: 1, skipped: 3 });
    assert.deepEqual(starts, [batchStart(busy)]);

    await leadOf(broken, "tick-1");
    starts.length = 0;
    await assert.rejects(tick(), (error) => codeOf(error) === "workflows_not_bound");
  } finally {
    unbind();
  }
  // Each of the activity's three attempts goes on to the busy workspace after the broken one.
  const tried = starts.map(({ input }) => input.workspaceId);
  assert.deepEqual(tried, [broken, busy, broken, busy, broken, busy]);
});

test("through the host: discovery.people_imported with ten ids starts qualification.batch:<workspace>:current, which qualifies them; a start while it runs starts none, one after it closed a new run; the tick's schedule every two minutes, overlap skip", async () => {
  const { workspaceId } = await workspaceWith(10);
  const personIds: string[] = [];
  for (let at = 0; at < 10; at += 1) personIds.push(await leadOf(workspaceId, `host-${at}`));
  fake.reset();
  fake.script(...personIds.map(() => answer()));
  // Each answer held back, so that the batch is still running when the test starts it again.
  fake.state.delayMs = 150;
  const taskQueue = `test-${randomUUID()}`;
  const options = { modules: qualification, taskQueue, healthPort: 0, schedules: "off" } as const;
  const host = await start({ ...options, client: app(), log });
  const tick = env.client.schedule.getHandle("qualification.batch_tick");
  try {
    const name = discovery["discovery.people_imported"];
    const payload = { workspaceId, jobId: "job_1", personIds };
    await inRun(workspaceId, (tx) =>
      platform.publish(outboxWriter(tx, workspaceId), name, payload),
    );
    const run = env.client.workflow.getHandle(`qualification.batch:${workspaceId}:current`);
    const first = await until(async () => {
      const described = await run.describe().catch(() => undefined);
      return described?.status.name === "RUNNING" ? described : undefined;
    });
    assert.deepEqual(await platform.startWorkflow(batchStart(workspaceId)), { started: false });
    const all = { selected: 10, filtered: 0, scored: 10, failed: 0, stopped: null };
    assert.deepEqual(await run.result(), all);
    const statuses = (await leads(workspaceId)).map(({ status }) => status);
    assert.deepEqual(statuses, Array(10).fill("qualified"));
    assert.deepEqual(await platform.startWorkflow(batchStart(workspaceId)), { started: true });
    const second = await run.describe();
    assert.notEqual(second.runId, first.runId);
    assert.deepEqual(await run.result(), { ...all, selected: 0, scored: 0 });

    const schedule = await tick.describe();
    assert.equal(schedule.action.workflowType, "qualification_batch_tick");
    assert.deepEqual(
      [schedule.spec.intervals?.map(({ every }) => every), schedule.policies.overlap],
      [[120_000], "SKIP"],
    );
  } finally {
    fake.state.delayMs = 0;
    await host.close();
    await tick.delete().catch(() => undefined);
  }
});

test("qualification_rescore re-scores the scored leads from their stored verdicts with the current criteria, every lead or the named persons, each with its event: no model call, no credits", async () => {
  const { workspaceId } = await workspaceWith(10);
  const personIds = [
    await leadOf(workspaceId, "rescore-a"),
    await leadOf(workspaceId, "rescore-b"),
  ];
  fake.reset();
  fake.script(answer(), answer());
  const scored = { selected: 2, filtered: 0, scored: 2, failed: 0, stopped: null };
  assert.deepEqual(await batch(workspaceId), scored);
  const calls = fake.recordedCalls.length;
  const spent = await usages(workspaceId);
  // must_haves, unknown, weighs 60: the fit (800 + 240) / 140 is 74, its priority with the intent
  // of 71 is 73, warm, instead of 88's 80, hot.
  const data = { weight: 60 };
  await inRun(workspaceId, (tx) => tx.criterion.updateMany({ where: { key: "must_haves" }, data }));
  const rescore = (input: object) =>
    runWorkflow("qualification_rescore", { workspaceId, ...input }, { activities });
  assert.deepEqual(await rescore({}), { rescored: 2, skipped: 0 });
  const decided = (await leads(workspaceId)).map(({ status, tier }) => [status, tier]);
  assert.deepEqual(decided, [
    ["qualified", "warm"],
    ["qualified", "warm"],
  ]);
  assert.deepEqual(await rescore({ personIds: [personIds[0]] }), { rescored: 0, skipped: 1 });
  assert.equal(fake.recordedCalls.length, calls);
  assert.deepEqual(await usages(workspaceId), spent);
  const where = { workspaceId, eventName: "qualification.lead_qualified" };
  const tiers = (await app().outboxEntry.findMany({ where, orderBy: { createdAt: "asc" } })).map(
    ({ payload }) => (payload as { tier: string }).tier,
  );
  assert.deepEqual(tiers, ["hot", "hot", "warm", "warm"]);
});

test("through the host: the route's request, qualification.rescore_requested in the outbox, starts qualification.rescore:<workspace>:<request>, which re-scores the lead with the saved criteria", async () => {
  const { workspaceId } = await workspaceWith(10);
  const personId = await leadOf(workspaceId, "route-1");
  fake.reset();
  fake.script(answer());
  const scored = { selected: 1, filtered: 0, scored: 1, failed: 0, stopped: null };
  assert.deepEqual(await batch(workspaceId), scored);
  const data = { weight: 60 };
  await inRun(workspaceId, (tx) => tx.criterion.updateMany({ where: { key: "must_haves" }, data }));
  const taskQueue = `test-${randomUUID()}`;
  const options = { modules: qualification, taskQueue, healthPort: 0, schedules: "off" } as const;
  const host = await start({ ...options, client: app(), log });
  try {
    // What POST …/qualification/rescore runs in the request's tenant run (the api's own test).
    const ask = () => requestRescore({ personIds: [personId] });
    const asked: { requestId: string; marked: number } = await inRun(workspaceId, ask);
    assert.equal(asked.marked, 1);
    const id = `qualification.rescore:${workspaceId}:${asked.requestId}`;
    const run = env.client.workflow.getHandle(id);
    const result = await until(() => run.result().catch(() => undefined));
    assert.deepEqual(result, { rescored: 1, skipped: 0 });
  } finally {
    await host.close();
    await env.client.schedule
      .getHandle("qualification.batch_tick")
      .delete()
      .catch(() => undefined);
  }
  const [lead] = await leads(workspaceId);
  assert.deepEqual([lead?.status, lead?.tier], ["qualified", "warm"]);
});

test("a batch over two audiences: each lead against its agent's audience, or the default, with its own excerpts, reserved under its audience's key; the snapshot and the lead name it; no excerpt in the history or a log line; after one audience changes, only its leads again", async (t) => {
  const { workspaceId, icpId } = await workspaceWith(10);
  const founders: string = await inRun(workspaceId, async (tx) => {
    const { criteria } = await readIcpForScoring(workspaceId);
    const id = platform.newId("icp");
    const mustHaves = "Founded the company";
    await tx.icp.create({
      data: { id, workspaceId, name: "Founders", isDefault: false, ...ICP, mustHaves },
    });
    const rows = criteria.map(({ key, weight, isMust, enabled }: Record<string, never>) => ({
      ...{ id: platform.newId("crit"), workspaceId, icpId: id, key, weight, isMust, enabled },
    }));
    await tx.criterion.createMany({ data: rows });
    return id;
  });
  const ownerUserId = "usr_owner";
  await createPlaybook(
    { workspaceId, icpId: founders, ownerUserId, sourceIds: ["src_founders"] },
    app(),
  );
  const signal = { kind: "signal", ref: "src_founders" };
  const found = await leadOf(workspaceId, "found-1", {}, signal);
  const imported = await leadOf(workspaceId, "imported-1");
  for (const id of [found, imported]) scripts.set(id, () => fake.script(answer()));
  const words = [1, 2, 3, 4, 5, 6, 7].map((n) => `Noor is hiring quokka wranglers, round ${n}`);
  const excerpts = async ({ personId }: { personId: string }) => (personId === found ? words : []);
  const restore = useSignalReader({ ...reader, excerpts });
  logs.raw.length = 0;
  try {
    fake.reset();
    const workflowId = `qualification_batch_audiences-${randomUUID()}`;
    const options = { activities: scripted, workflowId };
    const scored = { selected: 2, filtered: 0, scored: 2, failed: 0, stopped: null };
    assert.deepEqual(await runWorkflow("qualification_batch", { workspaceId }, options), scored);
    t.diagnostic(`history: ${workflowId}`);

    // The founder's five excerpts, anonymized, against Founders' must-haves; the import's none.
    const evidence = fake.recordedCalls.map((call) => {
      const { messages } = call.input as { messages: { content: { text: string }[] }[] };
      const text = messages.flatMap(({ content }) => content.map((part) => part.text)).join("");
      const block = (name: string) =>
        new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text)?.[1] ?? "";
      return [block("must_haves"), JSON.parse(block("evidence"))];
    });
    const anonymized = words.slice(0, 5).map((w) => w.replace("Noor", "[name]"));
    assert.deepEqual(evidence, [
      ["Founded the company", anonymized],
      [ICP.mustHaves, []],
    ]);
    const keys = (await usages(workspaceId)).map((usage) => usage.idempotencyKey).sort();
    const expected = [
      `qual:${found}:${founders}:1:fake-model:2`,
      `qual:${imported}:${icpId}:1:fake-model:2`,
    ];
    assert.deepEqual(keys, expected.sort());
    const audiences = async () => {
      const rows = await app().lead.findMany({ where: { workspaceId } });
      const snapshots = await app().scoreSnapshot.findMany({ where: { workspaceId } });
      const snapshotOf = (id: string | null) => snapshots.find((row) => row.id === id)?.icpId;
      return new Map(
        rows.map((row) => [
          row.personId,
          [row.icpIdScored, snapshotOf(row.currentScoreSnapshotId)],
        ]),
      );
    };
    assert.deepEqual(
      await audiences(),
      new Map([
        [found, [founders, founders]],
        [imported, [icpId, icpId]],
      ]),
    );

    // The excerpts stay in their activity: no history event holds one.
    const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
    // Each payload's data, base64 in the history's JSON, decoded.
    const decoded = JSON.stringify(history).replaceAll(/"data":"([\w+/=]+)"/g, (_, data) =>
      Buffer.from(data, "base64").toString("utf8"),
    );
    assert.match(decoded, new RegExp(found));
    assert.doesNotMatch(decoded, /quokka/);

    // Founders' targeting moves: its lead only, at the new version. The provider fails its
    // assessment after the excerpts were read: the host logs the activity's failure, with none.
    const moved = { version: 2, mustHaves: "Founded the company twice" };
    await inRun(workspaceId, (tx) => tx.icp.update({ where: { id: founders }, data: moved }));
    scripts.set(found, () => fake.failNext("llm_invalid_key"));
    const failed = { selected: 1, filtered: 0, scored: 0, failed: 1, stopped: "provider_failed" };
    assert.deepEqual(await batch(workspaceId), failed);
    const latest = (await usages(workspaceId)).at(-1);
    const key = `qual:${found}:${founders}:2:fake-model:2`;
    assert.deepEqual([latest?.idempotencyKey, latest?.status], [key, "released"]);
    assert.ok(logs.raw.some((line) => line.includes("worker: an activity failed")));
    assert.doesNotMatch(logs.raw.join(""), /quokka/);
  } finally {
    restore();
  }
});

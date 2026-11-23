// A member's new assessment of a lead end to end (lead-rescore-ai; core/modules/qualification/README.md
// "A new assessment"), on the slice's Temporal and a schema of its database, set up as
// qualification-batch.test.ts sets up the batch: the press, then qualification_batch on the LLM fake.
// A member's edit of the title is assessed with the new title, a new snapshot carries the member's
// verdict, one assessment is charged under the next round's key; a press with nothing changed is
// answered by the model's answer cache, free, its commit step run again too; a lead the hard filters
// stopped, its location edited, passes them; the provider's failures after a press count afresh; an
// assessment retried after the model answered keeps its charge.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TenantClient } from "@whytide/db";
import type { LlmFake } from "@whytide/providers";

// The LLM fake whatever the environment names: the providers' config reads it as it loads, below.
process.env.PROVIDER_LLM = "fake";

const { loadAgentTasks } = await import("@whytide/ai");
const { ids: creditIds } = await import("@whytide/credits");
const { createCreditsClient, grantAllowance } = await import("@whytide/credits/testing");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { getAdapter, llmPort } = await import("@whytide/providers");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { editLeadPerson } = await import(built("contacts/dist/domain/person-edit.js"));
const { useEnrichmentHold, useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { readIcpForScoring } = await import(built("icp/dist/index.js"));
const { requestReassess } = await import(
  built("qualification/dist/domain/member-reassess/index.js")
);
const { setMemberVerdict } = await import(built("qualification/dist/domain/member-verdict.js"));
const { useQualificationClient, useSignalReader } = await import(
  built("qualification/dist/testing/index.js")
);
const { useTenancyClient } = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
withTestWorkflowEnvironment();
const app = () => asRole("app");
useHashSalt("test-salt-".repeat(4));
// A new lead is judged at once here; contacts' enrichment-hold.test.ts holds one (gamma-en-040).
useEnrichmentHold(0);
useQualificationClient(app());
useTenancyClient(app());
platform.bindCreditsClient(createCreditsClient());
await loadAgentTasks();
const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const log = platform.createLogger({ destination: platform.collectLogs().destination });
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
/** The title a member writes: no other block of the input holds it. */
const EDITED = "Chief Revenue Officer";
/** The model's answer, its title verdicts quoting `title`, which the lead's data must hold. */
const answer = (title = TITLE) => ({
  verdicts: [
    { criterion: "title_function", verdict: "met", evidence: title },
    { criterion: "seniority", verdict: "met", evidence: title },
    { criterion: "company_size", verdict: "met", evidence: "51-200" },
    { criterion: "industry", verdict: "met", evidence: "Software" },
    { criterion: "location", verdict: "met", evidence: "Germany (DE)" },
    { criterion: "must_haves", verdict: "unknown", evidence: "" },
  ],
  disqualifiers: [],
  summary: "A revenue operations head at a software company.",
});
// Every person's signals, as qualification-batch.test.ts gives them: a known intent per decision.
useSignalReader({
  intentInputs: async ({ personIds }: { personIds: readonly string[] }) =>
    personIds.flatMap((personId) =>
      ["src_1", "src_2"].map((sourceId) => ({
        ...{ personId, sourceId, eventId: `evt_${personId}_${sourceId}`, count: 1 },
        ...{ kind: "topic_engagement", role: "comment", relevance: 1, intentClass: "other" },
        ...{ occurredAt: new Date(), ownerUserId: null },
      })),
    ),
  excerpts: async () => [],
});

/** A workspace of its own organization with 10 credits, the price listed, the ICP at version 1. */
async function workspace() {
  const organizationId = `org_${randomUUID()}`;
  const workspaceId = `wsp_${randomUUID()}`;
  await app().organization.create({
    data: { id: organizationId, name: "Org", slug: organizationId },
  });
  const row = { id: workspaceId, organizationId, name: "Workspace", slug: "workspace" };
  await app().workspace.create({ data: row });
  await grantAllowance([organizationId], 10);
  await asRole("billing_writer").priceListEntry.upsert({
    where: { action_version: { action: ACTION, version: 1 } },
    create: {
      id: platform.newId(creditIds.price_list_entry),
      ...{ action: ACTION, credits: 0.2, unit: "lead", version: 1, effectiveFrom: new Date() },
    },
    update: {},
  });
  await inRun(workspaceId, async (tx) => {
    const { id } = (await readIcpForScoring(workspaceId)).icp;
    await tx.icp.update({ where: { id }, data: ICP });
  });
  return workspaceId;
}
/** A pending lead with its company; `profile` changes the person. */
function leadOf(workspaceId: string, slug: string, profile: Record<string, string> = {}) {
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
    const source = { kind: "imported", ref: "imp_1" };
    await contacts.createLeadForPerson({ personId: stored.id, source });
    return stored.id as string;
  });
}
const batch = (workspaceId: string) =>
  runWorkflow("qualification_batch", { workspaceId }, { activities: scripted });
const scored = { selected: 1, filtered: 0, scored: 1, failed: 0, stopped: null };
const press = (workspaceId: string, personId: string) =>
  inRun(workspaceId, () => requestReassess(personId));
const leadRow = (personId: string) => app().lead.findFirstOrThrow({ where: { personId } });
const decision = async (personId: string) => {
  const row = await leadRow(personId);
  const { qualificationStatus: status, tier, fitScore, statusReason: reason } = row;
  return { status, tier, fitScore, reason, snapshotId: row.currentScoreSnapshotId };
};
/** The workspace's default audience: the ICP its leads are judged against. */
const audienceOf = (workspaceId: string): Promise<string> =>
  inRun(workspaceId, async () => (await readIcpForScoring(workspaceId)).icp.id);
/**
 * A lead's reservation key at its audience, the workspace's default, at version 1: since the
 * audiences (gamma-p5-050) the key names the audience; `:<attempt>` follows from the second.
 */
const keyOf = async (workspaceId: string, personId: string) =>
  `qual:${personId}:${await audienceOf(workspaceId)}:1:fake-model:2`;
/** Each reservation's key and status, oldest first. */
const usages = async (workspaceId: string) =>
  (
    await app().creditUsage.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).map((usage) => [usage.idempotencyKey, usage.status]);
const committed = async (workspaceId: string) =>
  (await inRun(workspaceId, () => platform.credits.balance(workspaceId))).committed;
/** The profile block of the model's last input: the person's fields as the batch read them. */
function lastProfile(): string {
  const call = fake.recordedCalls.at(-1)?.input as {
    messages: { content: { text: string }[] }[];
  };
  const text = call.messages.flatMap((message) => message.content.map((part) => part.text));
  return /<profile>\n([\s\S]*?)\n<\/profile>/.exec(text.join(""))?.[1] ?? "";
}
/** The workspace's batch steps run outside the workflow, by name, as a retried activity runs them. */
function stepsOf(workspaceId: string) {
  const context = {
    workspaceId,
    workflowId: `qualification.batch:${workspaceId}:current`,
    attempt: 2,
    tenant: <T>(fn: (tx: TenantClient) => Promise<T>) => inRun(workspaceId, fn),
  };
  return (name: string, input: object) =>
    loaded.activities.get(name)?.run({ workspaceId, ...input } as never, context as never);
}
const memberPart = (snapshotId: string | null, criterion: "industry" | "location") =>
  app().criterionVerdict.findFirst({
    where: { snapshotId: snapshotId ?? "", criterion },
    select: { verdict: true, memberVerdict: true, memberNote: true },
  });

test("after a member's edit of the title, a press makes the batch assess the lead again with the new title: a new snapshot carrying the member's verdict, a decision, one assessment's credits under the next round's key", async () => {
  const workspaceId = await workspace();
  const id = await leadOf(workspaceId, "edited-1");
  scripts.set(id, () => fake.script(answer()));
  fake.reset();
  assert.deepEqual(await batch(workspaceId), scored);
  const first = await decision(id);
  assert.equal(first.status, "qualified");
  await inRun(workspaceId, async () => {
    await setMemberVerdict(id, "industry", { verdict: "partially_met", note: "Fintech too" });
    await editLeadPerson(id, { title: EDITED });
  });

  assert.deepEqual(await press(workspaceId, id), { status: "pending", requested: true });
  assert.deepEqual((await decision(id)).reason, "member_requested");
  scripts.set(id, () => fake.script(answer(EDITED)));
  assert.deepEqual(await batch(workspaceId), scored);
  assert.equal(fake.recordedCalls.length, 2);
  assert.match(lastProfile(), new RegExp(EDITED));
  assert.doesNotMatch(lastProfile(), new RegExp(TITLE));

  const second = await decision(id);
  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.notEqual(second.status, "pending");
  assert.equal(second.reason, null);
  assert.deepEqual(await memberPart(second.snapshotId, "industry"), {
    verdict: "met",
    memberVerdict: "partially_met",
    memberNote: "Fintech too",
  });
  const key = await keyOf(workspaceId, id);
  assert.deepEqual(await usages(workspaceId), [
    [key, "committed"],
    [`${key}:4`, "committed"],
  ]);
  assert.equal(await committed(workspaceId), "0.4");
});

test("a press with nothing changed: the model's answer cache gives the stored snapshot back, so no model call, the reservation is committed at 0 credits and the lead decided again as it was; a second press, the same under the next round's key", async () => {
  const workspaceId = await workspace();
  const id = await leadOf(workspaceId, "same-1");
  scripts.set(id, () => fake.script(answer()));
  fake.reset();
  assert.deepEqual(await batch(workspaceId), scored);
  await inRun(workspaceId, () => setMemberVerdict(id, "location", { verdict: "partially_met" }));
  const before = await decision(id);
  // No script: a model call would fail the batch.
  scripts.delete(id);

  for (const round of [4, 7]) {
    assert.deepEqual(await press(workspaceId, id), { status: "pending", requested: true });
    assert.deepEqual(await batch(workspaceId), scored, `round ${round}`);
    assert.deepEqual(await decision(id), before, `round ${round}`);
  }
  assert.equal(fake.recordedCalls.length, 1);
  const kept = await memberPart(before.snapshotId, "location");
  assert.equal(kept?.memberVerdict, "partially_met");
  const key = await keyOf(workspaceId, id);
  assert.deepEqual(await usages(workspaceId), [
    [key, "committed"],
    [`${key}:4`, "committed"],
    [`${key}:7`, "committed"],
  ]);
  assert.equal(await committed(workspaceId), "0.2");
});

test("the commit step of a press with nothing changed, run again, finds its reservation settled at 0: no new reservation, no charge", async () => {
  const workspaceId = await workspace();
  const id = await leadOf(workspaceId, "again-1");
  scripts.set(id, () => fake.script(answer()));
  fake.reset();
  assert.deepEqual(await batch(workspaceId), scored);
  const before = await decision(id);
  await press(workspaceId, id);

  const step = stepsOf(workspaceId);
  const icpId = await audienceOf(workspaceId);
  const lead = { personId: id, icpId, icpVersion: 1 };
  const reserved = (await step("qualification_reserve", lead)) as { usageId: string };
  const assessed = (await step("qualification_assess", lead)) as { snapshotId: string };
  assert.equal(assessed.snapshotId, before.snapshotId);
  const held = { ...lead, usageId: reserved.usageId, attempt: 4, snapshotId: assessed.snapshotId };
  for (const run of [1, 2]) {
    const result = await step("qualification_commit", held);
    assert.deepEqual(result, { status: "committed" }, `run ${run}`);
  }
  assert.deepEqual(await decision(id), before);
  assert.equal(fake.recordedCalls.length, 1);
  const key = await keyOf(workspaceId, id);
  assert.deepEqual(await usages(workspaceId), [
    [key, "committed"],
    [`${key}:4`, "committed"],
  ]);
  assert.equal(await committed(workspaceId), "0.2");
});

test("a lead the hard filters stopped, its location edited by a member into the ICP's countries, is assessed after a press", async () => {
  const workspaceId = await workspace();
  const id = await leadOf(workspaceId, "moved-1", { locationText: "Paris, France" });
  fake.reset();
  const filtered = { selected: 1, filtered: 1, scored: 0, failed: 0, stopped: null };
  assert.deepEqual(await batch(workspaceId), filtered);
  assert.equal((await decision(id)).status, "hard_filtered");

  await inRun(workspaceId, () => editLeadPerson(id, { locationText: "Berlin, Germany" }));
  assert.deepEqual(await press(workspaceId, id), { status: "pending", requested: true });
  scripts.set(id, () => fake.script(answer()));
  assert.deepEqual(await batch(workspaceId), scored);
  assert.equal((await decision(id)).status, "qualified");
  const key = await keyOf(workspaceId, id);
  assert.deepEqual(await usages(workspaceId), [[`${key}:4`, "committed"]]);
});

test("a press on a lead the provider failed three times gives it a round of its own: the provider failing again leaves it waiting, and the next batch decides it", async () => {
  const workspaceId = await workspace();
  const id = await leadOf(workspaceId, "flaky-1");
  scripts.set(id, () => fake.failNext("llm_invalid_key"));
  fake.reset();
  for (let at = 0; at < 3; at += 1) await batch(workspaceId);
  assert.equal((await decision(id)).status, "ai_failed");

  assert.deepEqual(await press(workspaceId, id), { status: "pending", requested: true });
  const failed = { selected: 1, filtered: 0, scored: 0, failed: 1, stopped: "provider_failed" };
  assert.deepEqual(await batch(workspaceId), failed);
  const waiting = await decision(id);
  assert.deepEqual([waiting.status, waiting.reason], ["pending", "provider_failed"]);
  scripts.set(id, () => fake.script(answer()));
  assert.deepEqual(await batch(workspaceId), scored);
  assert.equal((await decision(id)).status, "qualified");
  const key = await keyOf(workspaceId, id);
  assert.deepEqual(await usages(workspaceId), [
    ...[key, `${key}:2`, `${key}:3`, `${key}:7`].map((each) => [each, "released"]),
    [`${key}:8`, "committed"],
  ]);
});

test("after a press, an assessment retried once the model answered gets the new snapshot from the cache, unscored: the commit charges the call, once", async () => {
  const workspaceId = await workspace();
  const id = await leadOf(workspaceId, "retried-1");
  scripts.set(id, () => fake.script(answer()));
  fake.reset();
  assert.deepEqual(await batch(workspaceId), scored);
  await inRun(workspaceId, () => editLeadPerson(id, { title: EDITED }));
  await press(workspaceId, id);

  const step = stepsOf(workspaceId);
  const icpId = await audienceOf(workspaceId);
  const lead = { personId: id, icpId, icpVersion: 1 };
  const reserved = (await step("qualification_reserve", lead)) as { usageId: string };
  assert.deepEqual(reserved, { status: "reserved", usageId: reserved.usageId, attempt: 4 });
  fake.script(answer(EDITED));
  const assessed = (await step("qualification_assess", lead)) as { snapshotId: string };
  assert.deepEqual(await step("qualification_assess", lead), assessed);
  assert.equal(fake.recordedCalls.length, 2);
  const held = { ...lead, usageId: reserved.usageId, attempt: 4, snapshotId: assessed.snapshotId };
  for (const run of [1, 2]) {
    const result = await step("qualification_commit", held);
    assert.deepEqual(result, { status: "committed" }, `run ${run}`);
  }
  assert.equal((await decision(id)).snapshotId, assessed.snapshotId);
  const key = await keyOf(workspaceId, id);
  assert.deepEqual(await usages(workspaceId), [
    [key, "committed"],
    [`${key}:4`, "committed"],
  ]);
});

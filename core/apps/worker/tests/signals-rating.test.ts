// signals' rating end to end (gamma-p5-030; core/modules/signals/README.md "Rating"), on the slice's
// Temporal and a schema of its database: credits, linkedin and signals loaded from their builds by
// the worker's own loader, on the LinkedIn, files and LLM fakes, linkedin's clock a working Wednesday
// at 10:00 UTC. A run drops a recruiter before the read, by the rules here (its triage step the
// rules', so that the model's answers are the rating's; signals-triage-ai), then rates its new events
// that hold words against Company Knowledge's offer: the model receives no name, profile URL,
// headline, company or member reference (the fake's recorded calls), and the workflow's history
// holds no words. A failing model leaves the events unrated and the run done with its leads; a run
// rates at most 100 events, ten a call, oldest first, and the next run of the source the oldest left.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Context } from "@temporalio/activity";
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";
import type { TenantClient } from "@whytide/db";
import type { FakeEngager as Engager, LinkedinFake, LlmFake } from "@whytide/providers";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.PROVIDER_LLM = "fake";

const { loadAgentTasks } = await import("@whytide/ai");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { getAdapter, linkedinPort, llmPort } = await import("@whytide/providers");
const { ids: creditsIds } = await import("@whytide/credits");
const { grantAllowance, useCreditsClient } = await import("@whytide/credits/testing");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
const { useHashSalt } = await built("contacts/dist/testing/index.js");
const { readIcpForScoring } = await built("icp/dist/index.js");
const linkedin = await built("linkedin/dist/testing/index.js");
const signals = await built("signals/dist/testing/index.js");
const tenancy = await built("tenancy/dist/testing/index.js");

withTestDb();
const env = withTestWorkflowEnvironment();
const db = () => asRole("app");
useCreditsClient(db());
linkedin.useLinkedinClient(db());
tenancy.useTenancyClient(db());
signals.useSignalsClient(db());
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
const principal = platform.servicePrincipal("signals_test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: db() });
const WEDNESDAY = new Date("2026-10-07T10:00:00.000Z");
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
const OFFER = {
  oneLiner: "Pipeline forecasts for revenue teams",
  products: ["Forecasts"],
  painPoints: ["Forecasts that miss"],
};
let posts = 0;

/** An engager `slug` named `name`, an hour and `at` minutes ago, its profile the ICP's. */
function engager(slug: string, at: number, name: string, extra: Partial<Engager> = {}): Engager {
  const profileUrl = `https://www.linkedin.com/in/${slug}`;
  const headline = `${TITLE} at ${COMPANY.companyName}`;
  const [firstName = "", lastName = ""] = name.split(" ");
  const profile = { providerMemberRef: slug, profileUrl, firstName, lastName, title: TITLE };
  fake.seedProfile({ ...profile, headline, locationText: "Berlin, Germany", ...COMPANY });
  const engagedAt = new Date(Date.now() - 3_600_000 - at * 60_000);
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

/** A workspace with credits, the ICP, Company Knowledge's offer, a connected account and a source on a post the fake seeds. */
async function sourceOf(seeded: Engager[]) {
  const writer = asRole("billing_writer");
  for (const [action, unit] of [
    ["signals.engager", "engager"],
    ["signals.engager_read", "engagers_30"],
  ] as const) {
    await writer.priceListEntry.createMany({
      data: {
        id: platform.newId(creditsIds.price_list_entry),
        ...{ action, credits: 1, unit, version: 1, effectiveFrom: new Date(Date.now() - 60_000) },
      },
      skipDuplicates: true,
    });
  }
  const [tenant] = await tenancy.createTwoWorkspaces();
  const workspaceId: string = tenant.workspace.id;
  await grantAllowance([tenant.organization.id], 100);
  await inRun(workspaceId, async (tx) => {
    const { id } = (await readIcpForScoring(workspaceId)).icp;
    await tx.icp.update({ where: { id }, data: ICP });
  });
  await db().companyKnowledge.create({ data: { id: platform.newId("ck"), workspaceId, ...OFFER } });
  const providerAccountRef = `fake-account-${randomUUID()}`;
  fake.emitWebhook("account.connected", providerAccountRef);
  const account = await linkedin.createConnectedAccount(workspaceId, { providerAccountRef });
  posts += 1;
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${Date.now()}${posts}`;
  fake.seedPost(postUrl, seeded);
  const source = await db().signalSource.create({
    data: {
      id: platform.newId("src"),
      ...{ workspaceId, kind: "post_engagers", config: { postUrl }, label: "Launch post" },
      ...{ senderAccountId: account.id, createdBy: tenant.user.id },
    },
  });
  return { workspaceId, sourceId: source.id };
}
type Source = Awaited<ReturnType<typeof sourceOf>>;
type RunResult = { runId: string; status: string };

/** A run of the source, its triage decided by the rules, and the id of its workflow. */
async function run(source: Source) {
  let workflowId = "";
  const signals_run_start = async (input: never) => {
    workflowId = Context.current().info.workflowExecution?.workflowId ?? "";
    return activities.signals_run_start?.(input);
  };
  const input = { workspaceId: source.workspaceId, sourceId: source.sourceId };
  const signals_triage_candidates = async (input: never) =>
    activities.signals_triage_fallback?.(input);
  const all = { activities: { ...activities, signals_run_start, signals_triage_candidates } };
  return { ...(await runWorkflow<RunResult>("signals_run", input, all)), workflowId };
}
const countsOf = async (runId: string) =>
  (await db().signalRun.findUniqueOrThrow({ where: { id: runId } })).counts as Record<
    string,
    number
  >;
const eventsOf = (workspaceId: string) =>
  db().signalEvent.findMany({
    where: { workspaceId },
    include: { evidence: true },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
/** What each model call received, as JSON. */
const sent = () =>
  llm.recordedCalls
    .filter(({ method }) => method === "model")
    .map(({ input }) => JSON.stringify(input));
/** The model's answer for events 1 to `count`. */
const answer = (count: number) => ({
  ratings: Array.from({ length: count }, (_, n) => ({
    ...{ index: n + 1, relevance: 0.5, rationale: "Mentions forecasts.", intentClass: "other" },
  })),
});
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

test("a run drops a recruiter before the read, then rates its event with words against the offer: relevance, rationale, class, the decision record, a re-score request; a like without words stays unrated; the model receives no name, profile URL, headline, company or member reference, and the history no words", async () => {
  linkedin.useClock(() => WEDNESDAY);
  llm.reset();
  const words = `Dana here: our forecasts miss by 30%, what do you use? Mail dana@blueharbor.example or +49 30 1234 5678`;
  const commenter = engager("rating-dana", 1, "Dana Okafor", {
    ...{ reaction: "comment", commentText: words },
  });
  const liker = engager("rating-lee", 2, "Lee Park");
  const recruiter: Engager = {
    ...liker,
    ...{
      providerMemberRef: "rating-robin",
      profileUrl: "https://www.linkedin.com/in/rating-robin",
    },
    ...{ name: "Robin Hale", headline: "Technical Recruiter | SaaS", reaction: "comment" },
    commentText: "Hiring revenue talent? Ask me",
  };
  const source = await sourceOf([commenter, liker, recruiter]);
  const rationale = "Says the forecasts miss and asks for a tool.";
  llm.script({
    ratings: [{ index: 1, relevance: 0.9, rationale, intentClass: "pain_or_complaint" }],
  });
  const result = await run(source);
  assert.equal(result.status, "done");
  assert.deepEqual(await countsOf(result.runId), {
    ...{ pages: 1, read: 3, staged: 3, created: 2, profiles_read: 2, dropped_recruiter: 1 },
    rated: 1,
  });
  const events = await eventsOf(source.workspaceId);
  const said = events.find(({ evidence }) => evidence[0]?.reaction === "comment");
  const liked = events.find(({ evidence }) => evidence[0]?.reaction === "like");
  assert.ok(said && liked && events.length === 2);
  assert.deepEqual(
    [said.relevance, said.relevanceRationale, said.intentClass, said.ratingStatus],
    [0.9, rationale, "pain_or_complaint", "rated"],
  );
  const record = await db().decisionRecord.findUniqueOrThrow({
    where: { id: said.decisionRecordId ?? "" },
  });
  assert.deepEqual(
    [record.task, record.subjectRef, record.status],
    ["signals.rate-engagement", source.sourceId, "ok"],
  );
  assert.deepEqual(
    [liked.ratingStatus, liked.relevance, liked.decisionRecordId],
    ["unrated", null, null],
  );
  const requests = await db().outboxEntry.findMany({
    where: { workspaceId: source.workspaceId, eventName: "qualification.rescore_requested" },
  });
  const persons = requests.map(({ payload }) => (payload as { personIds: unknown }).personIds);
  assert.deepEqual(persons, [[said.personId]]);
  // One call: the offer and the words scrubbed, never what names a person or a company.
  const [call = "", ...more] = sent();
  assert.deepEqual(more, []);
  const scrubbed =
    "[name] here: our forecasts miss by 30%, what do you use? Mail [email] or [phone]";
  assert.ok(call.includes(scrubbed) && call.includes(OFFER.oneLiner), call);
  const absent = [
    ...["Dana", "Okafor", "Lee Park", "Robin Hale", "rating-dana", "rating-lee", "rating-robin"],
    ...[commenter.profileUrl, commenter.headline, "Technical Recruiter", "Hiring revenue talent"],
    ...[COMPANY.companyName, "blue-harbor", "blueharbor", "1234 5678"],
  ];
  for (const value of absent) assert.ok(!call.includes(value), `the model received ${value}`);
  const history = await historyOf(result.workflowId);
  for (const value of ["forecasts miss", "Hiring revenue", rationale]) {
    assert.ok(!history.includes(value), `the history holds ${value}`);
  }
});

test("a model failing past the activity's attempts leaves the events unrated, and the run ends done with its leads", async () => {
  linkedin.useClock(() => WEDNESDAY);
  llm.reset();
  const words = { reaction: "comment" as const, commentText: "We still forecast in a spreadsheet" };
  const source = await sourceOf([engager("rating-ari", 1, "Ari Moss", words)]);
  for (const _ of [1, 2, 3]) llm.failNext("llm_provider_error");
  const result = await run(source);
  assert.equal(result.status, "done");
  assert.deepEqual(await countsOf(result.runId), {
    ...{ pages: 1, read: 1, staged: 1, created: 1, profiles_read: 1, unrated: 1 },
  });
  const events = await eventsOf(source.workspaceId);
  const rows = events.map((event) => [event.ratingStatus, event.relevance, event.decisionRecordId]);
  assert.deepEqual(rows, [["unrated", null, null]]);
  assert.equal(await db().lead.count({ where: { workspaceId: source.workspaceId } }), 1);
  assert.equal(sent().length, 3);
});

test("a run rates at most 100 events, ten a call, its oldest first; the next run of the source rates the oldest left", async () => {
  linkedin.useClock(() => WEDNESDAY);
  llm.reset();
  const source = await sourceOf([]);
  const start = Date.now() - 86_400_000;
  const seeded: { id: string }[] = [];
  for (let n = 0; n < 105; n += 1) {
    const event = { workspaceId: source.workspaceId, sourceId: source.sourceId };
    const words = { personId: `per_rating_${n}`, commentText: `Comment ${n} on forecasts` };
    const occurredAt = new Date(start + n * 60_000);
    seeded.push(await signals.createSignalEvent({ ...event, ...words, occurredAt }));
  }
  const unrated = async () =>
    (await eventsOf(source.workspaceId))
      .filter(({ ratingStatus }) => ratingStatus === "unrated")
      .map(({ id }) => id);
  llm.script(...Array.from({ length: 10 }, () => answer(10)));
  const first = await run(source);
  assert.equal(first.status, "done");
  const counts = await countsOf(first.runId);
  assert.deepEqual([counts.rated, counts.unrated, sent().length], [100, undefined, 10]);
  assert.deepEqual(
    await unrated(),
    seeded.slice(100).map(({ id }) => id),
  );
  llm.reset();
  llm.script(answer(5));
  const second = await run(source);
  assert.equal((await countsOf(second.runId)).rated, 5);
  const [call = ""] = sent();
  assert.ok(call.includes("Comment 100 on forecasts") && call.includes("Comment 104 on forecasts"));
  assert.deepEqual(await unrated(), []);
});

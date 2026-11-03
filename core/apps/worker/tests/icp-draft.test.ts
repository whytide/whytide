// icp's drafter end to end (icp-draft; core/modules/icp/README.md "The draft"), on the slice's
// Temporal, a schema of its database and the LLM fake: icp_draft_profile drafts the ICP from the
// workspace's Company Knowledge and the admin's brief, as the request left it. Synthetic data only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ActivityContext, ActivityDefinition } from "@whytide/platform";
import type { LlmFake } from "@whytide/providers";

// The fake, whatever .env.local names: a test never reaches a model's vendor.
process.env.PROVIDER_LLM = "fake";
const { DATA_SENTENCE, loadAgentTasks } = await import("@whytide/ai");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { collectLogs, createLogger } = await import("@whytide/platform");
const { getAdapter, llmPort } = await import("@whytide/providers");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");

withTestDb();
withTestWorkflowEnvironment();
const TASK = "../../../modules/icp/agents/draft-profile/task.ts";
await loadAgentTasks([new URL(TASK, import.meta.url).href]);
const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
beforeEach(() => fake.reset());
const db = () => asRole("app");
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};

/** The drafter's activity with callAgent's options: the test's schema and the fake's price. */
function withCall(definition: ActivityDefinition): ActivityDefinition {
  if (definition.scope === "global") return definition;
  const { run } = definition;
  return {
    ...definition,
    run: (input, context: ActivityContext) => {
      // What draftProfile reads besides the context (domain/drafter.ts, DraftContext).
      const withCall = { ...context, call: { client: db(), prices } };
      return run(input, withCall);
    },
  };
}
/** icp as the worker's loader loads it from its build, its drafter calling as above. */
const icp = moduleLoaders
  .filter(({ name }) => name === "icp")
  .map((loader) => ({
    ...loader,
    workflows: async () => {
      const declared = (await loader.workflows?.()) as {
        readonly activities: Record<string, ActivityDefinition>;
      };
      const { icp_draft_from_sources: drafter, ...rest } = declared.activities;
      const activities = {
        ...rest,
        icp_draft_from_sources: withCall(drafter as ActivityDefinition),
      };
      return { ...declared, activities };
    },
  }));
const log = createLogger({ destination: collectLogs().destination });
const loaded = await loadModules(icp);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: db(), log })];
  }),
);

const BRIEF = "Bakery chains in France and Belgium.";
const KNOWLEDGE = {
  sourceUrl: "https://ledger.example/",
  oneLiner: "Bookkeeping for independent bakeries",
  longDescription: "Ledger keeps the books of bakeries with one to three shops.",
  products: ["Ledger Books"],
  painPoints: ["Receipts pile up"],
  featuresBenefits: ["Scan a receipt and it is filed"],
  proofPoints: [{ text: "Trusted by 40 bakeries", sourceUrl: "https://ledger.example/customers" }],
  competitors: ["Quillbooks"],
  tone: "Plain and warm",
};
/** What the drafter reads of it: the content fields, the proof points' texts; no website, page or tone. */
const { sourceUrl, tone, ...content } = KNOWLEDGE;
const COMPANY = { ...content, proofPoints: ["Trusted by 40 bakeries"] };
const VALID = {
  name: "Bakery chains",
  titles: ["Owner", "Head of Finance"],
  seniorities: ["owner_founder", "head"],
  industries: ["Food and beverage"],
  sizeRanges: ["11-50", "51-200"],
  countries: ["FR", "BE"],
  mustHaves: "Runs two bakeries or more",
  disqualifiers: "Wholesale bakeries",
};

type Run = { workspaceId: string; icpId: string; draftRunId: string };
type Recorded = { system: string; messages: { role: string; content: { text: string }[] }[] };
const newId = (prefix: string) => `${prefix}_${randomUUID()}`;
/** A workspace's Company Knowledge, and its ICP as the request leaves it: drafting under a run. */
async function requested(): Promise<Run> {
  const run = { workspaceId: newId("wsp"), icpId: newId("icp"), draftRunId: newId("idrun") };
  const { workspaceId, icpId: id, draftRunId } = run;
  await db().companyKnowledge.create({ data: { id: newId("ck"), workspaceId, ...KNOWLEDGE } });
  const draft = { draftStatus: "drafting", draftRunId, draftBrief: BRIEF };
  await db().icp.create({ data: { id, workspaceId, ...draft } });
  return run;
}
const draft = (run: Run) => runWorkflow<unknown>("icp_draft_profile", run, { activities });
const stored = async (workspaceId: string) => {
  const { draftStatus, draftError, pendingDraft, titles, version } =
    await db().icp.findFirstOrThrow({ where: { workspaceId } });
  return { draftStatus, draftError, pendingDraft, untouched: [titles, version] };
};
const UNTOUCHED = [[], 1];
const userText = (index: number) =>
  (fake.recordedCalls[index]?.input as Recorded).messages
    .flatMap((message) => message.content.map((part) => part.text))
    .join("");

test("a valid answer ends drafted: the pending draft with its model, prompt version and decision record; the model read the content fields and the brief in their data blocks, nothing else", async () => {
  const run = await requested();
  fake.script(VALID);
  assert.deepEqual(await draft(run), { status: "drafted" });
  const { workspaceId } = run;
  const [decision, ...more] = await db().decisionRecord.findMany({ where: { workspaceId } });
  assert.equal(more.length, 0);
  const pending = { model: "fake-model", promptVersion: 1, decisionRecordId: decision?.id };
  assert.deepEqual(await stored(run.workspaceId), {
    ...{ draftStatus: "drafted", draftError: null },
    ...{ pendingDraft: { ...pending, fields: VALID }, untouched: UNTOUCHED },
  });
  const { system } = fake.recordedCalls[0]?.input as Recorded;
  assert.ok(system.startsWith(`Data blocks: <company>, <brief>\n${DATA_SENTENCE}\n`));
  const blocks = /^<company>\n([\s\S]*)\n<\/company>\n\n<brief>\n([\s\S]*)\n<\/brief>$/.exec(
    userText(0),
  );
  assert.deepEqual([JSON.parse(blocks?.[1] ?? "null"), blocks?.[2]], [COMPANY, BRIEF]);
  assert.equal(decision?.subjectRef, run.icpId);
});

test("an answer off the schema, then one the gate refuses: retried once, then failed ai_failed, nothing pending", async () => {
  const run = await requested();
  fake.script({ ...VALID, countries: ["XX"] }, { ...VALID, titles: ["Owner", "owner"] });
  assert.deepEqual(await draft(run), { status: "failed", code: "ai_failed" });
  assert.equal(fake.recordedCalls.length, 2);
  assert.deepEqual(await stored(run.workspaceId), {
    ...{ draftStatus: "failed", draftError: "ai_failed", pendingDraft: null, untouched: UNTOUCHED },
  });
});

test("a run a later request superseded while the model answered writes nothing", async () => {
  const run = await requested();
  fake.state.delayMs = 2_000;
  fake.script(VALID);
  const late = draft(run);
  for (const deadline = Date.now() + 30_000; fake.recordedCalls.length === 0; await sleep(20)) {
    assert.ok(Date.now() < deadline, "no model call within thirty seconds");
  }
  const draftRunId = newId("idrun");
  await db().icp.update({ where: { id: run.icpId }, data: { draftRunId } });
  assert.deepEqual(await late, { status: "superseded" });
  const icp = await db().icp.findFirstOrThrow({ where: { id: run.icpId } });
  assert.deepEqual(
    [icp.draftRunId, icp.draftStatus, icp.pendingDraft],
    [draftRunId, "drafting", null],
  );
});

test("a drafter failing past its three attempts marks the run failed, draft_failed, and fails the workflow", async () => {
  const run = await requested();
  for (let attempt = 0; attempt < 3; attempt += 1) fake.failNext("llm_provider_error");
  await assert.rejects(draft(run));
  assert.equal(fake.recordedCalls.length, 3);
  assert.deepEqual(await stored(run.workspaceId), {
    ...{ draftStatus: "failed", draftError: "draft_failed", pendingDraft: null },
    untouched: UNTOUCHED,
  });
});

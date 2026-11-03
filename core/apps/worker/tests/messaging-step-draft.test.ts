// messaging's drafts of a sequence's steps end to end (beta-p3-010; core/modules/messaging/README.md
// "The workflow"), on the slice's Temporal, a schema of its database and the LLM fake: messaging
// loaded from its build by the worker's own loader, its activities through the host's wrapper, its
// writer calling the model as the test's app role. A step's draft asked in a service's run, as
// campaigns asks it, written by messaging_draft_message as the sender account's owner; its failures;
// messaging_sweep over every workspace; last, the host's hourly schedule messaging.sweep. The replay
// of the recorded histories is `pnpm -F worker test:replay`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import { Client, Connection } from "@temporalio/client";
import type { ActivityContext, ActivityDefinition } from "@whytide/platform";
import type { LlmFake } from "@whytide/providers";
import type { ModuleLoader } from "../src/modules.ts";

// The LLM fake whatever the environment names: the providers' config reads it as it loads, below.
process.env.PROVIDER_LLM = "fake";

const { aiErrors, loadAgentTasks } = await import("@whytide/ai");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { getAdapter, llmPort } = await import("@whytide/providers");
const { hostActivity } = await import("../src/activities.ts");
const { workerConfig } = await import("../src/config.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { start } = await import("../src/start.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const { createLeadForPerson, upsertPersonFromSource } = await import(
  built("contacts/dist/index.js")
);
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { requestStepDraft } = await import(built("messaging/dist/index.js"));
const { createMessageDraft, createStepDraft, useMessagingClient } = await import(
  built("messaging/dist/testing/index.js")
);
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
withTestWorkflowEnvironment();
const app = () => asRole("app");
useHashSalt("test-salt-".repeat(4));
useMessagingClient(app());
tenancy.useTenancyClient(app());
await loadAgentTasks();
const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
beforeEach(() => fake.reset());
const log = platform.createLogger({ destination: platform.collectLogs().destination });
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};

/** The writer's activity with callAgent's options: the test's schema and the fake's price. */
function withCall(definition: ActivityDefinition): ActivityDefinition {
  if (definition.scope === "global") return definition;
  const { run } = definition;
  return {
    ...definition,
    run: (input, context: ActivityContext) => {
      // What writeDraft reads besides the context (domain/drafts/write.ts, DraftContext).
      const withCall = { ...context, call: { client: app(), prices } };
      return run(input, withCall);
    },
  };
}
/** messaging as the worker's loader loads it from its build, its writer calling as above. */
const messaging: ModuleLoader[] = moduleLoaders
  .filter(({ name }) => name === "messaging")
  .map((loader) => ({
    ...loader,
    workflows: async () => {
      const declared = (await loader.workflows?.()) as {
        readonly activities: Record<string, ActivityDefinition>;
      };
      const activities = Object.fromEntries(
        Object.entries(declared.activities).map(([name, definition]) => [
          name,
          name === "messaging_write_draft" ? withCall(definition) : definition,
        ]),
      );
      return { ...declared, activities };
    },
  }));
const loaded = await loadModules(messaging);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => [
    name,
    hostActivity(name, definition, { client: app(), log }),
  ]),
);

type Seeded = { workspaceId: string; personId: string; userId: string };
/** A workspace with a Member, the sender account's owner, and a lead with its profile only. */
async function seed(): Promise<Seeded> {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const user = await tenancy.createUser();
  await tenancy.createMembership({ userId: user.id, workspaceId: workspace.id, role: "Member" });
  const workspaceId: string = workspace.id;
  const personId = await asService(workspaceId, async () => {
    const profile = {
      linkedinUrl: `https://linkedin.com/in/ines-${randomUUID()}`,
      firstName: "Ines",
      lastName: "Duarte",
      headline: "Head of Data",
      title: "Head of Data",
      locationText: "Lisbon, Portugal",
    };
    const { person } = await upsertPersonFromSource({
      source: "linkedin",
      provider: null,
      profile,
    });
    await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "sev_1" } });
    return person.id as string;
  });
  return { workspaceId, personId, userId: user.id };
}
/** A run of a service, as campaigns asks for a step's draft: no member is its principal. */
function asService<T>(workspaceId: string, fn: () => Promise<T>) {
  const principal = platform.servicePrincipal("campaigns_test");
  return withTenant({ workspaceId, principal }, fn, { client: app() });
}
/** The step's draft asked for, and the input its messaging.draft_requested starts the run with. */
async function requested(
  seeded: Seeded,
  stepExecutionId: string,
  stepKey: string,
  earlier: string[] = [],
) {
  const { workspaceId, personId, userId } = seeded;
  const request = {
    personId,
    stepExecutionId,
    stepKey,
    senderUserId: userId,
    earlierDraftIds: earlier,
  };
  const { draftId } = (await asService(workspaceId, () => requestStepDraft(request))) as {
    draftId: string;
  };
  const where = { workspaceId, eventName: "messaging.draft_requested" };
  const events = await app().outboxEntry.findMany({ where });
  const event = events.find((entry) => (entry.payload as { draftId: string }).draftId === draftId);
  return { draftId, input: event?.payload as object };
}
const rowOf = (id: string) => app().messageDraft.findUniqueOrThrow({ where: { id } });
const draft = (input: object) =>
  runWorkflow<{ status: string }>("messaging_draft_message", input, { activities });
/** The workspace's messaging.step_draft_ready payloads, by draft id. */
const ends = async (workspaceId: string) =>
  (
    await app().outboxEntry.findMany({
      where: { workspaceId, eventName: "messaging.step_draft_ready" },
    })
  )
    .map(({ payload }) => payload as { draftId: string; status: string })
    .sort((a, b) => a.draftId.localeCompare(b.draftId));
type Recorded = { messages: { content: { text: string }[] }[] };
/** A block of the recorded call's user message, parsed. */
function blockOf(index: number, name: string): unknown {
  const { messages } = fake.recordedCalls[index]?.input as Recorded;
  const text = messages.flatMap((message) => message.content.map((part) => part.text)).join("");
  const found = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text);
  return JSON.parse(found?.[1] ?? "undefined");
}
/** The code of the activity failure that failed a workflow. */
const codeOf = (error: unknown) =>
  (error as { cause?: { cause?: { type?: string } } }).cause?.cause?.type;

const PLAN = { angle: "pain_point", factIds: ["f_2"], cta: "question" };
const sized = (start: string, length: number) => `${start.padEnd(length - 1, " so")}?`;
const FIRST = sized("Ines, how does your team follow up on warm leads", 180);
const FOLLOW_UP = sized("Ines, what slows your team down when warm leads go cold", 200);
const MINUTE = 60_000;

test("a message_1 and a follow_up_1 written through messaging_draft_message as the sender's owner: each call's <step>, one decision record and one cost event per call, each draft's step_draft_ready", async () => {
  const seeded = await seed();
  const { workspaceId, personId, userId } = seeded;
  const first = await requested(seeded, "sx_1", "message_1");
  assert.deepEqual(first.input, {
    workspaceId,
    draftId: first.draftId,
    personId,
    userId,
    earlierDraftIds: [],
  });
  fake.script(PLAN, { text: FIRST });
  assert.deepEqual(await draft(first.input), { status: "ready" });
  const opening = { kind: "first_message", earlier: [] };
  assert.deepEqual([blockOf(0, "step"), blockOf(1, "step")], [opening, opening]);
  const written = await rowOf(first.draftId);
  assert.deepEqual(
    [written.kind, written.channel, written.status, written.text, written.promptVersion],
    ["outbound_step", "linkedin_message", "ready", FIRST, 2],
  );

  // Approved as approvals' path leaves it (beta-p3-020): the follow-up builds on its text.
  const approvedAt = new Date();
  await app().messageDraft.update({
    where: { id: first.draftId },
    data: { status: "approved", approvedAt },
  });
  const second = await requested(seeded, "sx_2", "follow_up_1", [first.draftId]);
  fake.reset();
  fake.script({ ...PLAN, cta: "soft_ask" }, { text: FOLLOW_UP });
  assert.deepEqual(await draft(second.input), { status: "ready" });
  const following = { kind: "follow_up", earlier: [{ stepKey: "message_1", text: FIRST }] };
  assert.deepEqual([blockOf(0, "step"), blockOf(1, "step")], [following, following]);
  assert.equal((await rowOf(second.draftId)).text, FOLLOW_UP);

  const records = await app().decisionRecord.findMany({ where: { workspaceId } });
  const costs = await app().costEvent.findMany({ where: { workspaceId } });
  assert.deepEqual([records.length, costs.length], [4, 4]);
  assert.ok(costs.every((cost) => cost.subjectRef === personId));
  assert.deepEqual(
    await ends(workspaceId),
    [
      { draftId: first.draftId, stepExecutionId: "sx_1", status: "ready" },
      { draftId: second.draftId, stepExecutionId: "sx_2", status: "ready" },
    ].sort((a, b) => a.draftId.localeCompare(b.draftId)),
  );
});

test("a model that fails twice ends the step's draft failed with no text, one record and one cost; a writer failed past its attempts marks it write_failed; each publishes `failed`", async () => {
  const seeded = await seed();
  const { workspaceId } = seeded;
  const failing = await requested(seeded, "sx_ai", "message_1");
  fake.script("no plan", "no plan");
  assert.deepEqual(await draft(failing.input), { status: "failed" });
  const failed = await rowOf(failing.draftId);
  assert.deepEqual(
    [failed.status, failed.text, failed.flagReasons],
    ["failed", null, [{ code: "ai_failed" }]],
  );
  assert.equal(fake.recordedCalls.length, 2, "the answer, and its one retry");
  const records = await app().decisionRecord.count({ where: { workspaceId } });
  const costs = await app().costEvent.count({ where: { workspaceId } });
  assert.deepEqual([records, costs], [1, 1]);

  const broken = await requested(seeded, "sx_fault", "follow_up_1");
  const definition = loaded.activities.get("messaging_write_draft");
  if (definition === undefined) throw new Error("messaging_write_draft is not loaded");
  const run = async () => {
    throw new platform.AppError(aiErrors.ai_budget_exceeded);
  };
  const writer = hostActivity(
    "messaging_write_draft",
    { ...definition, run },
    { client: app(), log },
  );
  await assert.rejects(
    runWorkflow("messaging_draft_message", broken.input, {
      activities: { ...activities, messaging_write_draft: writer },
    }),
    (error) => codeOf(error) === "ai_budget_exceeded",
  );
  const marked = await rowOf(broken.draftId);
  assert.deepEqual(
    [marked.status, marked.text, marked.flagReasons],
    ["failed", null, [{ code: "write_failed" }]],
  );
  assert.deepEqual(
    (await ends(workspaceId)).map(({ draftId, status }) => [draftId, status]),
    [failing.draftId, broken.draftId]
      .sort((a, b) => a.localeCompare(b))
      .map((id) => [id, "failed"]),
  );
});

test("messaging_sweep fails every workspace's drafts stuck in `drafting` past 30 minutes, draft_stuck, with no text, and publishes a step's event; a younger one stays", async () => {
  const [a, b] = [await seed(), await seed()];
  const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE);
  const drafting = { status: "drafting", text: "a text no failed draft keeps" };
  const stuck = await createStepDraft({
    ...a,
    ...drafting,
    stepExecutionId: "sx_stuck",
    createdAt: ago(31),
  });
  const young = await createStepDraft({
    ...a,
    ...drafting,
    stepExecutionId: "sx_young",
    createdAt: ago(5),
  });
  const lead = await createMessageDraft({ ...b, ...drafting, createdAt: ago(60) });
  assert.deepEqual(await runWorkflow("messaging_sweep", {}, { activities }), {
    stuck: 2,
    unswept: 0,
  });
  for (const id of [stuck, lead]) {
    const row = await rowOf(id);
    assert.deepEqual(
      [row.status, row.text, row.flagReasons],
      ["failed", null, [{ code: "draft_stuck" }]],
    );
  }
  assert.equal((await rowOf(young)).status, "drafting");
  assert.deepEqual(await ends(a.workspaceId), [
    { draftId: stuck, stepExecutionId: "sx_stuck", status: "failed" },
  ]);
  assert.deepEqual(await ends(b.workspaceId), []);
});

test("the host's schedule messaging.sweep starts messaging_sweep hourly, paused while WORKER_SCHEDULES is off", async () => {
  const connection = await Connection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  const temporal = new Client({ connection, namespace: workerConfig.TEMPORAL_NAMESPACE });
  const schedule = temporal.schedule.getHandle("messaging.sweep");
  await schedule.delete().catch(() => undefined);
  const taskQueue = `test-${randomUUID()}`;
  const host = await start({
    modules: messaging,
    taskQueue,
    healthPort: 0,
    client: app(),
    log,
    schedules: "off",
  });
  try {
    const described = await schedule.describe();
    const every = described.spec.intervals?.map((interval) => interval.every);
    assert.deepEqual(
      [described.action.workflowType, every, described.state.paused],
      ["messaging_sweep", [60 * MINUTE], true],
    );
  } finally {
    await host.close();
    await schedule.delete().catch(() => undefined);
    await connection.close();
  }
});

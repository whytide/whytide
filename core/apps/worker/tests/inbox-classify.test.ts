// inbox's reply classifier end to end (gamma-p4-040; core/modules/inbox/README.md "The classifier",
// docs/flows.md "A reply classified"), on the slice's Temporal, a schema of its database and the LLM
// fake: inbox loaded from its build by the worker's own loader, its classifier's activity calling the
// model as the test's app role, the host started with it. A reply through the store publishes
// inbox.reply_received, which the host's outbox delivers; the classifier's run, by
// inbox.classify:<workspace>:<message>, sends the masked reply to the model, stores its label with
// its call, and campaigns acts on it; a second delivery starts no second run. Run by itself, as its
// recorded histories have it: a model's answer, and a model failing past the activity's 3 attempts,
// which leaves the fallback, other and suggested, acting on nothing. The input, the result, the
// history, the events and the log lines hold ids, statuses and labels, never a text. The histories
// replay. Contacts', linkedin's, tenancy's, campaigns' and inbox's helpers come from their builds. It
// lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";
import type { ActivityContext, ActivityDefinition } from "@whytide/platform";
import type { LlmFake } from "@whytide/providers";
import type { ModuleLoader } from "../src/modules.ts";

// The fakes, whatever the environment names: nothing here calls a model or a provider, or mails.
process.env.PROVIDER_LLM = "fake";
process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.PROVIDER_APP_MAIL = "fake";

const { loadAgentTasks } = await import("@whytide/ai");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { filesPort, getAdapter, llmPort } = await import("@whytide/providers");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { start } = await import("../src/start.ts");
const { replayHistories, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { createEnrollment } = await import(built("campaigns/dist/testing/index.js"));
const inbox = await import(built("inbox/dist/testing/index.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const env = withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
tenancy.useTenancyClient(app);
await loadAgentTasks();
const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
beforeEach(() => fake.reset());
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
const files = await getAdapter(filesPort, "fake");
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};
const HISTORIES = ["inbox_classify_reply", "inbox_classify_reply_failed"].map((name) =>
  fileURLToPath(built(`inbox/workflows/__histories__/${name}.json`)),
);
const UNTIL_MS = 30_000;
const STEPS = ["connect", "message_1", "follow_up_1", "follow_up_2"];
const TEMPLATE = "linkedin_default";
const NOTHING = { actions: [], enrollmentIds: [] };

/** The classifier's activity with callAgent's options: the test's schema and the fake's price. */
function withCall(definition: ActivityDefinition): ActivityDefinition {
  if (definition.scope === "global") return definition;
  const { run } = definition;
  return {
    ...definition,
    run: (input, context: ActivityContext) => {
      // What classifyReply reads besides the context (inbox's domain/classify, ClassifyContext).
      const withCall = { ...context, call: { client: app, prices } };
      return run(input, withCall);
    },
  };
}
/** inbox as the worker's loader loads it from its build, its classifier calling as above. */
const modules: ModuleLoader[] = moduleLoaders
  .filter(({ name }) => name === "inbox")
  .map((loader) => ({
    ...loader,
    workflows: async () => {
      const declared = (await loader.workflows?.()) as {
        readonly activities: Record<string, ActivityDefinition>;
      };
      const activities = Object.fromEntries(
        Object.entries(declared.activities).map(([name, definition]) => [
          name,
          name === "inbox_classify" ? withCall(definition) : definition,
        ]),
      );
      return { ...declared, activities };
    },
  }));
const taskQueue = `test-${randomUUID()}`;
let host: { close(): Promise<void> } | undefined;
before(async () => {
  host = await start({ modules, taskQueue, healthPort: 0, schedules: "off", client: app, log });
});
after(async () => {
  await host?.close();
  await env.client.schedule
    .getHandle("inbox.reply_draft_sweep")
    .delete()
    .catch(() => undefined);
});

type Seeded = { workspaceId: string; senderAccountId: string; personId: string };
const answer = (label: string, confidence: number) => ({ label, confidence, returnDate: null });
const execute = (workflow: string, input: unknown, workflowId = `${workflow}-${randomUUID()}`) =>
  env.client.workflow.execute(workflow, { args: [input], taskQueue, workflowId });
const stepsOf = async (personId: string) =>
  (await app.stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } })).map(
    ({ status }) => status,
  );
const rowOf = (messageId: string) =>
  app.replyClassification.findFirstOrThrow({ where: { messageId } });

/** A workspace, its owner's account, and Noor's lead in a campaign on it: the request sent. */
async function enrolled(): Promise<Seeded & { enrollmentId: string }> {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const workspaceId: string = workspace.id;
  const owner: { id: string } = await tenancy.createUser();
  const account = await linkedin.createConnectedAccount(workspaceId, { ownerUserId: owner.id });
  const principal = platform.servicePrincipal("inbox_test");
  const personId: string = await withTenant(
    { workspaceId, principal },
    async () => {
      const linkedinUrl = `https://linkedin.com/in/classify-${randomUUID()}`;
      const profile = { linkedinUrl, firstName: "Noor" };
      const { person } = await contacts.upsertPersonFromSource({
        ...{ source: "import", provider: "csv", profile },
      });
      const source = { kind: "imported", ref: "imp_1" };
      await contacts.createLeadForPerson({ personId: person.id, source });
      const actor = { type: "system" };
      await contacts.recordLeadStatus(person.id, "approved", { actor });
      await contacts.recordLeadStatus(person.id, "in_campaign", { actor, templateId: TEMPLATE });
      return person.id;
    },
    { client: app },
  );
  const steps = STEPS.map((stepKey, i) => ({ stepKey, status: i === 0 ? "succeeded" : "planned" }));
  const seeded = { workspaceId, senderAccountId: account.id, personId };
  const { id: enrollmentId } = await createEnrollment({ ...seeded, steps }, app);
  return { ...seeded, enrollmentId };
}
/** A reply through the store, its file as the receiver writes it: the stored message. */
async function throughTheStore({ workspaceId, senderAccountId, personId }: Seeded, text: string) {
  const file = {
    ...{ chatRef: `chat-${randomUUID()}`, messageRef: `message-${randomUUID()}` },
    ...{ senderMemberRef: "member-noor", attendeeMemberRefs: ["member-self"] },
    ...{ fromAccount: false, sentAt: new Date().toISOString(), text },
  };
  const key = `raw/linkedin/messages/${randomUUID()}.json`;
  const body = JSON.stringify(file);
  const put = await files.put({ workspaceId, key, body, contentType: "application/json" });
  const input = { workspaceId, senderAccountId, personId, direction: "in", fileKey: put.key };
  const { messageId } = (await execute("inbox_store_message", input)) as { messageId: string };
  return app.message.findUniqueOrThrow({ where: { id: messageId } });
}
/** A reply written straight to the tables, as the store leaves it, with no event: its ids. */
async function stored({ workspaceId, personId }: Seeded, text: string, sentAt: Date) {
  const threadId: string = await inbox.createThread({ workspaceId, personId }, app);
  const message = { workspaceId, threadId, personId, body: text, sentAt };
  return { threadId, personId, messageId: (await inbox.createMessage(message, app)) as string };
}
/** The first defined answer of `probe`, asked every 50 ms for 30 seconds at most. */
async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + UNTIL_MS;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    assert.ok(Date.now() < deadline, "until: nothing within thirty seconds");
    await sleep(50);
  }
}
/** No text in the workspace's events, a log line, or the runs' histories, payloads decoded. */
async function noText(workspaceId: string, workflowIds: readonly string[], texts: string[]) {
  const outbox = await app.outboxEntry.findMany({ where: { workspaceId } });
  const seen = [...outbox.map(({ payload }) => JSON.stringify(payload)), ...logs.raw];
  for (const id of workflowIds) {
    const history = await env.client.workflow.getHandle(id).fetchHistory();
    seen.push(
      JSON.stringify(JSON.parse(historyToJSON(history)), (_key, value) => {
        const { data, metadata } = (value ?? {}) as { data?: unknown; metadata?: unknown };
        return typeof data === "string" && metadata
          ? Buffer.from(data, "base64").toString()
          : value;
      }),
    );
  }
  for (const line of seen) {
    for (const text of texts) assert.ok(!line.includes(text), `a text in a trace: ${text}`);
  }
}

test("through the host: a stored reply's inbox.reply_received starts one run by inbox.classify:<workspace>:<message>; the model gets the reply masked, its not_interested at 0.9 is stored with its call, campaigns cancels the held steps, and inbox.reply_classified is published; a second delivery starts none; no text in a trace", async () => {
  const seeded = await enrolled();
  const { workspaceId, personId, enrollmentId } = seeded;
  fake.script(answer("not_interested", 0.9));

  const { id: messageId, threadId } = await throughTheStore(seeded, "Not for us, thanks. Noor");
  const workflowId = `inbox.classify:${workspaceId}:${messageId}`;
  const run = env.client.workflow.getHandle(workflowId);
  await until(() => run.describe().catch(() => undefined));
  assert.deepEqual(await run.result(), { status: "classified", origin: "model", newest: true });

  const sent = JSON.stringify(fake.recordedCalls);
  assert.ok(sent.includes("Not for us, thanks. [name]") && !sent.includes("Noor"), "masked");
  const row = await rowOf(messageId);
  const [record] = await app.decisionRecord.findMany({ where: { workspaceId } });
  assert.deepEqual(
    [row.label, row.confidence, row.isSuggested, row.origin, row.decisionRecordId, record?.task],
    ["not_interested", 0.9, false, "model", record?.id, "inbox.classify-reply"],
  );
  const actions = ["label_recorded", "steps_cancelled", "cool_down_set"];
  assert.deepEqual(row.actionsTaken, { actions, enrollmentIds: [enrollmentId] });
  assert.deepEqual(await stepsOf(personId), ["succeeded", "cancelled", "cancelled", "cancelled"]);
  const where = { workspaceId, eventName: "inbox.reply_classified" };
  const classified = { classificationId: row.id, messageId, threadId, personId };
  assert.deepEqual(
    (await app.outboxEntry.findMany({ where })).map(({ payload }) => payload),
    [{ ...classified, label: "not_interested" }],
  );

  const { runId } = await run.describe();
  const received = await app.outboxEntry.findFirstOrThrow({
    where: { workspaceId, eventName: "inbox.reply_received" },
  });
  await app.outboxEntry.update({ where: { id: received.id }, data: { deliveredAt: null } });
  await until(async () => {
    const entry = await app.outboxEntry.findUniqueOrThrow({ where: { id: received.id } });
    return entry.deliveredAt ?? undefined;
  });
  assert.equal((await run.describe()).runId, runId, "the same run, none after it");
  const calls = fake.recordedCalls.filter(({ method }) => method === "model");
  assert.equal(calls.length, 1, "one model call");
  await noText(workspaceId, [workflowId], ["Not for us"]);
});

test("run by itself, as its recorded histories: the model's interested is stored; a model failing past the activity's 3 attempts leaves the fallback, other, suggested, with no call, acting on nothing", async (t) => {
  const seeded = await enrolled();
  const { workspaceId, personId } = seeded;
  const minuteAgo = new Date(Date.now() - 60_000);
  const first = await stored(seeded, "Sounds good, tell me more.", minuteAgo);
  fake.script(answer("interested", 0.9));
  const okId = `inbox_classify_reply-${randomUUID()}`;

  const ok = await execute("inbox_classify_reply", { workspaceId, ...first }, okId);

  assert.deepEqual(ok, { status: "classified", origin: "model", newest: true });
  // The run whose history is workflows/__histories__/inbox_classify_reply.json (history:record).
  t.diagnostic(`inbox_classify_reply ran as ${okId}`);
  assert.equal((await rowOf(first.messageId)).label, "interested");

  const second = await stored(seeded, "Thanks, next week works.", new Date());
  for (let attempt = 1; attempt <= 3; attempt += 1) fake.failNext("llm_provider_error");
  const failedId = `inbox_classify_reply-${randomUUID()}`;

  const failed = await execute("inbox_classify_reply", { workspaceId, ...second }, failedId);

  assert.deepEqual(failed, { status: "classified", origin: "fallback", newest: true });
  // The run whose history is workflows/__histories__/inbox_classify_reply_failed.json.
  t.diagnostic(`inbox_classify_reply fell back as ${failedId}`);
  const row = await rowOf(second.messageId);
  assert.deepEqual(
    [row.label, row.isSuggested, row.origin, row.decisionRecordId, row.actionsTaken],
    ["other", true, "fallback", null, NOTHING],
  );
  assert.deepEqual(await stepsOf(personId), ["succeeded", "planned", "planned", "planned"]);
  await noText(workspaceId, [okId, failedId], ["Sounds good", "next week"]);
});

test("the recorded histories of inbox_classify_reply replay", () =>
  replayHistories(env.workflowsPath, HISTORIES));

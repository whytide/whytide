// inbox's reply draft end to end (inbox-reply-draft; core/modules/inbox/README.md "The reply draft",
// docs/flows.md "A reply drafted"), on the slice's Temporal, a schema of its database and the LLM
// fake: inbox loaded from its build by the worker's own loader, its writer's activity calling the
// model as the test's app role, the host started with it. A member's request through inbox's own
// domain publishes inbox.reply_draft_requested, which the host's outbox delivers and whose run writes
// the draft; the writer reads the thread's latest messages and the brief as data. A rewrite, a second
// refusal, the provider failing past the attempts, a late answer dropped, the sweep. The input, the
// result, the history and the events hold ids, statuses and codes, never a text. The recorded
// histories replay. Contacts', linkedin's, tenancy's, messaging's and inbox's code and helpers come
// from their builds. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";
import type { TenantClient } from "@whytide/db";
import type { ActivityContext, ActivityDefinition, Principal } from "@whytide/platform";
import type { LlmFake } from "@whytide/providers";
import type { ModuleLoader } from "../src/modules.ts";

// The fakes, whatever the environment names: nothing here calls a model or a provider.
process.env.PROVIDER_LLM = "fake";
process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";

const { loadAgentTasks } = await import("@whytide/ai");
const { outboxWriter, withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { getAdapter, llmPort } = await import("@whytide/providers");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { start } = await import("../src/start.ts");
const { replayHistories, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { events } = await import(built("inbox/dist/events.js"));
const { requestReplyDraft } = await import(built("inbox/dist/domain/reply-draft/request.js"));
const inbox = await import(built("inbox/dist/testing/index.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
const { useMessagingClient } = await import(built("messaging/dist/testing/index.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const env = withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
useMessagingClient(app);
tenancy.useTenancyClient(app);
await loadAgentTasks();
const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
beforeEach(() => fake.reset());
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};
const HISTORIES = ["inbox_draft_reply", "inbox_draft_reply_failed", "inbox_reply_draft_sweep"].map(
  (name) => fileURLToPath(built(`inbox/workflows/__histories__/${name}.json`)),
);
const UNTIL_MS = 30_000;

/** The writer's activity with callAgent's options: the test's schema and the fake's price. */
function withCall(definition: ActivityDefinition): ActivityDefinition {
  if (definition.scope === "global") return definition;
  const { run } = definition;
  return {
    ...definition,
    run: (input, context: ActivityContext) => {
      // What writeReply reads besides the context (messaging's domain/drafts/write.ts, DraftContext).
      const withCall = { ...context, call: { client: app, prices } };
      return run(input, withCall);
    },
  };
}
/** inbox as the worker's loader loads it from its build, its writer calling as above. */
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
          name === "inbox_write_reply_draft" ? withCall(definition) : definition,
        ]),
      );
      return { ...declared, activities };
    },
  }));
const taskQueue = `test-${randomUUID()}`;
let host: { close(): Promise<void> } | undefined;
before(async () => {
  // inbox's schedule (inbox.reply_draft_sweep) paused, and deleted after: no test leaves one.
  host = await start({ modules, taskQueue, healthPort: 0, schedules: "off", client: app, log });
});
after(async () => {
  await host?.close();
  await env.client.schedule
    .getHandle("inbox.reply_draft_sweep")
    .delete()
    .catch(() => undefined);
});

const BRIEF = "Say yes and offer a short call on Tuesday or Thursday.";
const READY = "Ana, yes: a short call on Tuesday or Thursday works. Would either suit you?";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 9, minute));
type Seeded = { workspaceId: string; userId: string; personId: string; threadId: string };
type Recorded = { messages: { content: { text: string }[] }[] };

/**
 * A workspace with a Member who owns a connected account, Ana's lead with her member id, and their
 * thread on it with `count` messages, the lead's and the seller's in turn, a minute apart.
 */
async function seed(count = 2): Promise<Seeded> {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const workspaceId: string = workspace.id;
  const user: { id: string } = await tenancy.createUser();
  await tenancy.createMembership({ userId: user.id, workspaceId, role: "Member" });
  const account = await linkedin.createConnectedAccount(workspaceId, { ownerUserId: user.id });
  const principal = platform.servicePrincipal("inbox_test");
  const personId: string = await withTenant(
    { workspaceId, principal },
    async () => {
      const profile = {
        ...{ linkedinUrl: `https://linkedin.com/in/ana-${randomUUID()}`, firstName: "Ana" },
        ...{ lastName: "Lead", providerId: `member-${randomUUID()}` },
      };
      const source = { source: "linkedin", provider: "unipile", profile } as const;
      const { person } = await contacts.upsertPersonFromSource(source);
      await contacts.createLeadForPerson({
        personId: person.id,
        source: { kind: "signal", ref: "sev_1" },
      });
      return person.id;
    },
    { client: app },
  );
  const thread = { workspaceId, personId, senderAccountId: account.id, ownerUserId: user.id };
  const threadId: string = await inbox.createThread(thread, app);
  for (let index = 1; index <= count; index += 1) {
    const direction = index % 2 === 1 ? "in" : "out";
    const body = `${direction === "in" ? "Lead" : "Seller"} line ${index}.`;
    const message = { workspaceId, threadId, personId, direction, body, sentAt: at(index) };
    await inbox.createMessage(message, app);
  }
  return { workspaceId, userId: user.id, personId, threadId };
}
/** A run of the member's request, as the route's tenant run is. */
function asMember<T>({ workspaceId, userId }: Seeded, fn: (tx: TenantClient) => Promise<T>) {
  const principal: Principal = {
    ...{ userId, actorType: "human", authMethod: "session", workspaceId, role: "Member" },
    scopes: [],
  };
  return withTenant({ workspaceId, principal }, fn, { client: app });
}
/** A draft drafting, as the request leaves it, without its event: the test runs it. */
const drafting = (seeded: Seeded, given: { brief?: string; replacedText?: string } = {}) =>
  inbox.createReplyDraft(
    {
      ...{ ...given, workspaceId: seeded.workspaceId, threadId: seeded.threadId },
      ...{ status: "drafting", requestedBy: seeded.userId },
    },
    app,
  );
const rowOf = (id: string) => app.replyDraft.findUniqueOrThrow({ where: { id } });
/** inbox_draft_reply on the host's queue, under `workflowId`. */
const draft = (input: { workspaceId: string; draftId: string }, workflowId = newRun()) =>
  env.client.workflow.execute("inbox_draft_reply", { args: [input], taskQueue, workflowId });
const newRun = (name = "inbox_draft_reply") => `${name}-${randomUUID()}`;
/** A block of the recorded call's user message, parsed as JSON, or as it is for a string. */
function blockOf(index: number, name: string): unknown {
  const { messages } = fake.recordedCalls[index]?.input as Recorded;
  const text = messages.flatMap((message) => message.content.map((part) => part.text)).join("");
  const found = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text)?.[1];
  try {
    return JSON.parse(found ?? "undefined");
  } catch {
    return found;
  }
}
/** A run's history decoded: the events as JSON, then each payload's text. */
async function historyOf(id: string): Promise<string> {
  const history = await env.client.workflow.getHandle(id).fetchHistory();
  const decoded: string[] = [];
  const raw = JSON.stringify(JSON.parse(historyToJSON(history)), (_key, value) => {
    const data = (value as { metadata?: unknown; data?: unknown } | null)?.data;
    if (typeof data === "string" && (value as { metadata?: unknown }).metadata) {
      decoded.push(Buffer.from(data, "base64").toString("utf8"));
    }
    return value;
  });
  return [raw, ...decoded].join("\n");
}
/** No text in the workspace's events, a log line, or the runs' histories. */
async function noText(workspaceId: string, workflowIds: readonly string[], texts: string[]) {
  const outbox = await app.outboxEntry.findMany({ where: { workspaceId } });
  const seen = [...outbox.map(({ payload }) => JSON.stringify(payload)), ...logs.raw];
  for (const id of workflowIds) seen.push(await historyOf(id));
  for (const line of seen) {
    for (const text of texts) assert.ok(!line.includes(text), `a text in a trace: ${text}`);
  }
}
/** The first defined answer of `probe`, asked every 50 ms for 30 seconds at most. */
async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + UNTIL_MS;
  for (;;) {
    const answer = await probe();
    if (answer !== undefined) return answer;
    assert.ok(Date.now() < deadline, "until: nothing within thirty seconds");
    await sleep(50);
  }
}

test("through the host: a member's request publishes inbox.reply_draft_requested, which starts one run by inbox.reply_draft:<workspace>:<draft>; it writes the draft ready with its model, prompt version and decision record; the writer read the latest 20 of 22 messages, oldest first, without a reply the inbox failed to send, and the brief, as data; a second delivery starts none", async () => {
  const seeded = await seed(22);
  const { workspaceId, threadId, personId } = seeded;
  const failed = await inbox.createMessage(
    { workspaceId, threadId, personId, direction: "out", body: "Never sent.", sentAt: at(30) },
    app,
  );
  const data = {
    sendStatus: "failed",
    errorCode: "send_failed",
    createdBy: seeded.userId,
  } as const;
  await app.message.update({ where: { id: failed }, data });
  fake.script({ text: READY });

  const requested = await asMember<{ status: string }>(seeded, () =>
    requestReplyDraft(threadId, BRIEF),
  );
  assert.equal(requested.status, "drafting");
  const { id } = await app.replyDraft.findFirstOrThrow({ where: { threadId } });
  const ended = await until(async () => {
    const row = await rowOf(id);
    return row.status === "drafting" ? undefined : row;
  });
  const [record] = await app.decisionRecord.findMany({ where: { workspaceId } });
  assert.deepEqual(
    [ended.status, ended.text, ended.modelId, ended.promptVersion, ended.decisionRecordId],
    ["ready", READY, "fake-model", 2, record?.id],
  );
  assert.equal(record?.task, "messaging.write-reply");
  const conversation = blockOf(0, "conversation") as { from: string; text: string }[];
  assert.equal(conversation.length, 20);
  assert.deepEqual(
    [conversation[0], conversation.at(-1)].map((message) => [message?.from, message?.text]),
    [
      ["lead", "Lead line 3."],
      ["seller", "Seller line 22."],
    ],
  );
  assert.equal(blockOf(0, "brief"), BRIEF);
  const workflowId = `inbox.reply_draft:${workspaceId}:${id}`;
  const run = env.client.workflow.getHandle(workflowId);
  assert.deepEqual(await run.result(), { status: "ready" });
  const { runId } = await run.describe();

  const name = events["inbox.reply_draft_requested"];
  const again = await asMember(seeded, (tx) =>
    platform.publish(outboxWriter(tx, workspaceId), name, { draftId: id }),
  );
  const delivered = await until(async () => {
    const row = await app.outboxEntry.findUniqueOrThrow({ where: { id: again } });
    return row.deliveredAt === null && row.lastError === null ? undefined : row;
  });
  assert.deepEqual([delivered.lastError, (await run.describe()).runId], [null, runId]);
  assert.equal(fake.recordedCalls.length, 1, "one model call");
  await noText(workspaceId, [workflowId], [BRIEF, READY, "Lead line", "Seller line"]);
});

test("a draft with a brief and the ready text it replaces: both reach the writer as data, and the draft is ready; the run's input, result and history hold ids and statuses only", async (t) => {
  const seeded = await seed();
  const replaced = "Ana, thanks for your note.";
  const draftId = await drafting(seeded, { brief: BRIEF, replacedText: replaced });
  fake.script({ text: READY });
  const workflowId = newRun();

  assert.deepEqual(await draft({ workspaceId: seeded.workspaceId, draftId }, workflowId), {
    status: "ready",
  });
  // The run whose history is workflows/__histories__/inbox_draft_reply.json (history:record).
  t.diagnostic(`inbox_draft_reply ran as ${workflowId}`);
  assert.deepEqual([blockOf(0, "brief"), blockOf(0, "replaced")], [BRIEF, replaced]);
  const row = await rowOf(draftId);
  assert.deepEqual([row.status, row.text, row.errorCode], ["ready", READY, null]);
  assert.deepEqual(await draft({ workspaceId: seeded.workspaceId, draftId }), { status: "ready" });
  assert.equal(fake.recordedCalls.length, 1, "a run on a draft no longer drafting writes nothing");
  await noText(seeded.workspaceId, [workflowId], [BRIEF, READY, replaced, "Lead line"]);
});

test("an answer the gates refuse is written again once with its issues; a second refusal fails the draft gates_failed, its decision record kept, and the run ends; Try again, a new draft, asks the model again", async () => {
  const seeded = await seed();
  const draftId = await drafting(seeded);
  const invented = "Ana, Globex saw 3 times more replies. Would you like to hear how?";
  fake.script({ text: invented }, { text: `${invented} [calendar link]` });

  assert.deepEqual(await draft({ workspaceId: seeded.workspaceId, draftId }), {
    status: "failed",
  });
  assert.deepEqual(blockOf(1, "failures"), [
    [
      { gate: "grounding", entity: "3" },
      { gate: "grounding", entity: "Globex" },
    ],
  ]);
  const row = await rowOf(draftId);
  const records = await app.decisionRecord.findMany({ where: { workspaceId: seeded.workspaceId } });
  assert.deepEqual([row.status, row.text, row.errorCode], ["failed", null, "gates_failed"]);
  assert.ok(records.some(({ id }) => id === row.decisionRecordId));

  // Try again with the same thread and brief, as the request does: the failed row replaced by a new
  // one. Its id is the writer's <request>, so callAgent's cache does not answer it with the failure.
  await app.replyDraft.delete({ where: { id: draftId } });
  const again = await drafting(seeded);
  const grounded = "Ana, thanks for asking. Would a short call next week suit you?";
  fake.script({ text: grounded });
  assert.deepEqual(await draft({ workspaceId: seeded.workspaceId, draftId: again }), {
    status: "ready",
  });
  assert.deepEqual([fake.recordedCalls.length, blockOf(2, "request")], [3, again]);
  const ready = await rowOf(again);
  assert.deepEqual([ready.status, ready.text], ["ready", grounded]);
});

test("the writer failing past its three attempts: the draft failed with the provider's code, llm_provider_error, by inbox_reply_draft_failed, and the workflow fails", async (t) => {
  const seeded = await seed();
  const draftId = await drafting(seeded);
  for (let attempt = 0; attempt < 3; attempt += 1) fake.failNext("llm_provider_error");
  const workflowId = newRun();

  await assert.rejects(draft({ workspaceId: seeded.workspaceId, draftId }, workflowId));
  // The run whose history is workflows/__histories__/inbox_draft_reply_failed.json.
  t.diagnostic(`inbox_draft_reply failed as ${workflowId}`);
  assert.equal(fake.recordedCalls.length, 3);
  const row = await rowOf(draftId);
  assert.deepEqual([row.status, row.text, row.errorCode], ["failed", null, "llm_provider_error"]);
});

test("a draft a later request replaced while the model answered: the late answer is dropped, the run answers gone, the new draft stays drafting", async () => {
  const seeded = await seed();
  const draftId = await drafting(seeded);
  fake.state.delayMs = 2_000;
  fake.script({ text: READY });
  const late = draft({ workspaceId: seeded.workspaceId, draftId });
  await until(async () => (fake.recordedCalls.length > 0 ? true : undefined));
  await app.replyDraft.delete({ where: { id: draftId } });
  const next = await drafting(seeded);

  assert.deepEqual(await late, { status: "gone" });
  const row = await rowOf(next);
  assert.deepEqual([row.status, row.text], ["drafting", null]);
});

test("the sweep fails every workspace's drafts drafting past 30 minutes, draft_stuck; a newer one and an ended one stay", async (t) => {
  const [a, b] = [await seed(), await seed()];
  const old = new Date(Date.now() - 31 * 60_000);
  const stuck = [
    await inbox.createReplyDraft(
      { workspaceId: a.workspaceId, threadId: a.threadId, status: "drafting", requestedAt: old },
      app,
    ),
    await inbox.createReplyDraft(
      { workspaceId: b.workspaceId, threadId: b.threadId, status: "drafting", requestedAt: old },
      app,
    ),
  ];
  const c = await seed();
  const fresh = await drafting(c);
  const d = await seed();
  const ready = await inbox.createReplyDraft(
    { workspaceId: d.workspaceId, threadId: d.threadId, requestedAt: old },
    app,
  );
  const workflowId = newRun("inbox_reply_draft_sweep");

  const result = await env.client.workflow.execute("inbox_reply_draft_sweep", {
    args: [{}],
    taskQueue,
    workflowId,
  });
  // The run whose history is workflows/__histories__/inbox_reply_draft_sweep.json.
  t.diagnostic(`inbox_reply_draft_sweep ran as ${workflowId}`);
  assert.deepEqual(result, { stuck: 2, unswept: 0 });
  const states = await Promise.all(
    [...stuck, fresh, ready].map(async (id) => {
      const { status, errorCode } = await rowOf(id);
      return [status, errorCode];
    }),
  );
  assert.deepEqual(states, [
    ["failed", "draft_stuck"],
    ["failed", "draft_stuck"],
    ["drafting", null],
    ["ready", null],
  ]);
});

test("the recorded histories of inbox_draft_reply, its failure and the sweep replay", () =>
  replayHistories(env.workflowsPath, HISTORIES));

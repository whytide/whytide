// inbox's store (beta-p5-010; core/modules/inbox/README.md "The store", docs/flows.md), on the
// slice's Temporal and a schema of its database, the LinkedIn, files and LLM fakes bound: inbox
// loaded from its build by the worker's own loader, inbox_store_message run by the host. An inbound
// message's file: the thread made, the message stored, every pending step held, inbox.reply_received
// published, the file deleted, and the text in no workflow input, result or history, no event and no
// log line. A missing file holds and stores nothing; an outbound message, the account's own, is stored
// as the user's, holds nothing and loses its file (tests/inbox-sent-messages.test.ts has the rest); an
// invalid file holds, stays and fails inbox_file_invalid (the activity's body, called as the host
// calls it, without Temporal's five attempts). A reply racing privacy's erasure waits on the
// lead the erasure locks after the platform's step, then writes nothing back. The recorded history
// replays. Contacts', linkedin's, tenancy's, campaigns', approvals', privacy's and inbox's code and
// helpers come from their builds, the files the loader's modules import. It lives here: a module
// never imports a host, and inbox cannot import privacy, which imports it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TenantClient } from "@whytide/db";

// The fakes, whatever the environment names: nothing here calls a provider or a model, nor may.
process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.PROVIDER_LLM = "fake";

const { tenantClient, withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { filesPort, getAdapter } = await import("@whytide/providers");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { start } = await import("../src/start.ts");
const { replayHistories, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { createApprovalItem } = await import(built("approvals/dist/testing/index.js"));
const campaigns = await import(built("campaigns/dist/ids.js"));
const { storeMessage } = await import(built("inbox/dist/workflows/index.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
const { useClient } = await import(built("privacy/dist/domain/client.js"));
const { erase } = await import(built("privacy/dist/domain/erase/erase.js"));
const { registeredErasers } = await import(built("privacy/dist/domain/erase/registry.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const env = withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
tenancy.useTenancyClient(app);
useClient(app);
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
const files = await getAdapter(filesPort, "fake");
const principal = platform.servicePrincipal("inbox_test");
const HISTORY = fileURLToPath(built("inbox/workflows/__histories__/inbox_store_message.json"));

const TEMPLATE = { templateId: "linkedin_default", templateVersion: 1 };
/** The template's steps, the request sent and three pending. */
const STEPS = [
  ["connect", "succeeded"],
  ["message_1", "scheduled"],
  ["follow_up_1", "awaiting_approval"],
  ["follow_up_2", "planned"],
] as const;
const HELD = [
  ["connect", "succeeded"],
  ["message_1", "held"],
  ["follow_up_1", "held"],
  ["follow_up_2", "held"],
];
const PENDING = STEPS.map(([key, status]) => [key, status]);

type Input = {
  workspaceId: string;
  senderAccountId: string;
  personId: string;
  direction: "in" | "out";
  fileKey: string;
};
/** privacy's eraser, as its registry holds it (privacy/domain/erase/registry.ts). */
type Eraser = {
  readonly module: string;
  readonly erase: (personId: string) => Promise<Record<string, number>>;
};
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });

/** A workspace's account and a person in a campaign on it, the steps as STEPS has them. */
async function enrolled(slug: string) {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const workspaceId: string = workspace.id;
  const { id: senderAccountId } = await linkedin.createConnectedAccount(workspaceId, {
    ownerUserId: "usr_inbox_owner",
  });
  const personId: string = await inRun(workspaceId, async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const source = { source: "import", provider: "csv", profile };
    const { person } = await contacts.upsertPersonFromSource(source);
    await contacts.createLeadForPerson({
      personId: person.id,
      source: { kind: "imported", ref: "imp_1" },
    });
    const actor = { type: "system" };
    await contacts.recordLeadStatus(person.id, "approved", { actor });
    await contacts.recordLeadStatus(person.id, "in_campaign", {
      actor,
      templateId: "linkedin_default",
    });
    return person.id;
  });
  const enrollmentId = platform.newId(campaigns.ids.enrollment);
  const owner = { workspaceId, personId, senderAccountId, ...TEMPLATE };
  const started = {
    status: "active" as const,
    sourceEventId: platform.newId("obx"),
    startedAt: new Date(),
  };
  await app.enrollment.create({ data: { id: enrollmentId, ...owner, ...started } });
  await app.stepExecution.createMany({
    data: STEPS.map(([stepKey, status], i) => ({
      ...{ id: platform.newId(campaigns.ids.step_execution), enrollmentId, ...owner },
      ...{
        stepKey,
        status,
        position: i + 1,
        actionType: i === 0 ? ("invite" as const) : ("message" as const),
      },
      ...{ stepTemplateHash: randomUUID(), idempotencyKey: randomUUID() },
    })),
  });
  return { workspaceId, senderAccountId, personId };
}

/** The file of a message as linkedin's receiver writes it, under raw/: its whole key. */
async function fileOf(workspaceId: string, body: unknown): Promise<string> {
  const key = `raw/linkedin/messages/${randomUUID()}.json`;
  const json = JSON.stringify(body);
  return (await files.put({ workspaceId, key, body: json, contentType: "application/json" })).key;
}
const message = (text: string, fromAccount = false) => ({
  chatRef: `chat-${randomUUID()}`,
  messageRef: `message-${randomUUID()}`,
  senderMemberRef: fromAccount ? "member-self" : "member-noor",
  attendeeMemberRefs: [fromAccount ? "member-noor" : "member-self"],
  fromAccount,
  sentAt: new Date().toISOString(),
  text,
});
/** Whether the file is still there. */
async function kept(workspaceId: string, key: string): Promise<boolean> {
  try {
    await files.get({ workspaceId, key });
    return true;
  } catch (error) {
    if (platform.isAppError(error) && error.code === "files_not_found") return false;
    throw error;
  }
}
const stepsOf = async (personId: string) =>
  (await app.stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } })).map(
    ({ stepKey, status }) => [stepKey, status],
  );
const rowsOf = async (workspaceId: string) => ({
  threads: await app.thread.count({ where: { workspaceId } }),
  messages: await app.message.count({ where: { workspaceId } }),
});

/** Resolves once a transaction waits on the backend `pid`'s locks; five seconds at most. */
async function blockedBy(pid: number): Promise<void> {
  for (let waited = 0; ; waited += 1) {
    const [blocked] = await asRole("owner").$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
    if ((blocked?.n ?? 0) > 0) return;
    assert.ok(waited < 200, `nothing waited on backend ${pid}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A promise and its resolver, to hold a transaction open until a test releases it. */
function gate<T = void>(): { promise: Promise<T>; open: (value: T) => void } {
  let open: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** `fn` with the host started, inbox alone, on a queue of its own; closed after. */
async function withHost(
  fn: (run: (id: string, input: Input) => Promise<unknown>) => Promise<void>,
) {
  const taskQueue = `test-${randomUUID()}`;
  const modules = moduleLoaders.filter(({ name }) => name === "inbox");
  const host = await start({
    modules,
    taskQueue,
    healthPort: 0,
    schedules: "off",
    client: app,
    log,
  });
  const run = (workflowId: string, input: Input) =>
    env.client.workflow.execute("inbox_store_message", { args: [input], taskQueue, workflowId });
  try {
    await fn(run);
  } finally {
    await host.close();
  }
}

test("an inbound message: the thread made, the message stored, every pending step held, the event published, the file deleted; no text in the input, the result, the history, the event or a log line", () =>
  withHost(async (run) => {
    const { workspaceId, senderAccountId, personId } = await enrolled("store-in");
    const file = message("Thanks, Thursday at ten works for me.");
    const fileKey = await fileOf(workspaceId, file);
    const input: Input = { workspaceId, senderAccountId, personId, direction: "in", fileKey };
    const workflowId = `inbox_store_message-${randomUUID()}`;

    const result = (await run(workflowId, input)) as { messageId: string };

    const stored = await app.message.findFirstOrThrow({ where: { workspaceId } });
    assert.deepEqual(result, { stored: true, messageId: stored.id, held: true, optOut: false });
    const thread = await app.thread.findFirstOrThrow({ where: { workspaceId } });
    assert.deepEqual(
      [thread.providerThreadRef, thread.senderAccountId, thread.ownerUserId, thread.personId],
      [file.chatRef, senderAccountId, "usr_inbox_owner", personId],
    );
    assert.deepEqual(
      [stored.threadId, stored.direction, stored.body, stored.providerMessageRef],
      [thread.id, "in", file.text, file.messageRef],
    );
    assert.deepEqual(await stepsOf(personId), HELD);
    const events = await app.outboxEntry.findMany({
      where: { workspaceId, eventName: "inbox.reply_received" },
    });
    assert.deepEqual(
      events.map(({ payload }) => payload),
      [{ messageId: stored.id, threadId: thread.id, personId }],
    );
    assert.equal(await kept(workspaceId, fileKey), false, "the file is deleted");
    const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
    const seen = [JSON.stringify(history), JSON.stringify(input), JSON.stringify(result)];
    seen.push(...logs.raw, ...(await app.outboxEntry.findMany()).map((row) => JSON.stringify(row)));
    for (const text of seen) assert.ok(!text.includes("Thursday at ten"), "no text");
  }));

test("a missing file holds the person's steps and stores nothing; an outbound message is stored as the user's, holds nothing and loses its file", () =>
  withHost(async (run) => {
    const gone = await enrolled("store-missing");
    const missing = `w/${gone.workspaceId}/raw/linkedin/messages/${randomUUID()}.json`;
    const input = { ...gone, direction: "in", fileKey: missing } as const;
    assert.deepEqual(await run(`inbox_store_message-${randomUUID()}`, input), {
      ...{ stored: false, held: true, optOut: false },
    });
    assert.deepEqual(await stepsOf(gone.personId), HELD);
    assert.deepEqual(await rowsOf(gone.workspaceId), { threads: 0, messages: 0 });

    const sent = await enrolled("store-out");
    const fileKey = await fileOf(sent.workspaceId, message("Here is the deck.", true));
    const output = { ...sent, direction: "out", fileKey } as const;
    const own = (await run(`inbox_store_message-${randomUUID()}`, output)) as { messageId: string };
    const stored = await app.message.findFirstOrThrow({ where: { workspaceId: sent.workspaceId } });
    assert.deepEqual(own, { stored: true, messageId: stored.id, held: false, optOut: false });
    assert.deepEqual([stored.direction, stored.sentBy], ["out", "user"]);
    assert.deepEqual(await stepsOf(sent.personId), PENDING);
    assert.deepEqual(await rowsOf(sent.workspaceId), { threads: 1, messages: 1 });
    assert.equal(await kept(sent.workspaceId, fileKey), false, "the file is deleted");
  }));

test("an invalid file, or one that is not the person's message, holds the steps, stays and fails inbox_file_invalid", async () => {
  for (const [slug, body] of [
    ["store-invalid", { text: "Not a message file." }],
    ["store-own", message("The account's own words.", true)],
  ] as const) {
    const { workspaceId, senderAccountId, personId } = await enrolled(slug);
    const fileKey = await fileOf(workspaceId, body);
    const input = { workspaceId, senderAccountId, personId, direction: "in", fileKey } as const;
    // The activity's body, with the run the host gives it (src/activities.ts).
    const tenant = <T>(fn: (tx: TenantClient) => Promise<T>) => inRun(workspaceId, fn);
    const context = { workspaceId, tenant };

    await assert.rejects(storeMessage(context, input), { code: "inbox_file_invalid" });

    assert.deepEqual(await stepsOf(personId), HELD, slug);
    assert.deepEqual(await rowsOf(workspaceId), { threads: 0, messages: 0 });
    assert.equal(await kept(workspaceId, fileKey), true, "the file stays for the runbook");
  }
});

test("a reply racing privacy's erasure waits on the lead, which the erasure locks after the platform's step, then writes nothing back", async () => {
  const { workspaceId, senderAccountId, personId } = await enrolled("store-erase-race");
  // A pending item on a pending step: the reply's hold blocks it, approvals' eraser deletes it.
  const step = await app.stepExecution.findFirstOrThrow({
    where: { personId, stepKey: "follow_up_1" },
  });
  const item = { workspaceId, personId, senderAccountId, stepExecutionId: step.id };
  await createApprovalItem({ ...item, stepKey: "follow_up_1" }, app);
  const fileKey = await fileOf(workspaceId, message("Call me on Friday."));
  // privacy's erasure with its registered erasers, approvals' paused once it deleted the item. The
  // hold locks the lead, the enrollment, the steps, then the items: with the lead still free here,
  // it would take the steps and wait on the item, and the erasure, on to campaigns', on the steps.
  const paused = gate<number>();
  const released = gate();
  const erasers = (registeredErasers() as Eraser[]).map((eraser) =>
    eraser.module !== "approvals"
      ? eraser
      : {
          ...eraser,
          erase: async (id: string) => {
            const counts = await eraser.erase(id);
            const [row] = await tenantClient.$queryRaw<{ pid: number }[]>`
              SELECT pg_backend_pid() AS pid`;
            paused.open(row?.pid ?? 0);
            await released.promise;
            return counts;
          },
        },
  );
  const request = { workspaceId, person: { id: personId }, operator: "dpo@example.com" };
  const erasing = erase({ ...request, dryRun: false }, erasers);
  // An erasure that fails before the pause fails the test here, with its error.
  const pid = await Promise.race([paused.promise, erasing.then(() => 0)]);
  assert.ok(pid > 0, "approvals' eraser paused the erasure");
  // The reply while the erasure runs, the activity's body as the host calls it: its hold waits.
  const tenant = <T>(fn: (tx: TenantClient) => Promise<T>) => inRun(workspaceId, fn);
  const input = { workspaceId, senderAccountId, personId, direction: "in", fileKey } as const;
  const storing = storeMessage({ workspaceId, tenant }, input);
  try {
    await blockedBy(pid);
  } finally {
    released.open();
  }

  // Both settle first, so that a deadlock leaves no transaction open behind the test.
  await Promise.allSettled([erasing, storing]);
  const [erasure, result] = await Promise.all([erasing, storing]);
  assert.deepEqual(erasure.counts.approvals, { approval_items: 1 });
  assert.deepEqual(erasure.counts.campaigns, { step_executions: 4, enrollments: 1 });
  assert.deepEqual(result, { stored: false, held: true, optOut: false });
  assert.deepEqual(await rowsOf(workspaceId), { threads: 0, messages: 0 });
  assert.equal(await kept(workspaceId, fileKey), false, "the file is deleted");
  const where = { workspaceId, eventName: "inbox.reply_received" };
  assert.equal(await app.outboxEntry.count({ where }), 0, "no event");
  assert.equal(await app.lead.count({ where: { personId } }), 0, "the lead is erased");
});

test("the recorded history of inbox_store_message replays", () =>
  replayHistories(env.workflowsPath, [HISTORY]));

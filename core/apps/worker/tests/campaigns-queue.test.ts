// campaigns' queue end to end (beta-p3-050; core/modules/campaigns/README.md "The queue", "The
// decision"), on the slice's Temporal and a schema of its database: campaigns and messaging loaded
// from their builds by the worker's own loader, the activities through the host's wrapper, the
// subscribers run by the worker's outbox loop, and the workflow starter bound to a recorder, so
// messaging's writer, which its subscriber to messaging.draft_requested starts, does not run (its own
// test is messaging-step-draft.test.ts). The
// tick starts each workspace's queue run for its 15-minute slot; an enrolled lead's connection
// request gets an item and its empty note at the first run, and the next day's run keeps the
// unapproved item; approve and skip through approvals' commands, as its routes run them, move the
// steps, and a follow-up's draft is asked as the account's owner from the drafts already sent; after
// a hold, a late Approve answers 409. Contacts', linkedin's, tenancy's, messaging's, approvals' and
// campaigns' code and test helpers come from their builds, the files the loader's modules import. It
// lives here: a module never imports a host. The replay of the recorded histories is
// `pnpm -F worker test:replay`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TenantClient } from "@whytide/db";
import type { Principal, WorkflowStart } from "@whytide/platform";

// The fakes, whatever the environment names: nothing here calls a provider, and nothing may.
process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_LLM = "fake";

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { startOutboxLoop } = await import("../src/outbox.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { approveLead } = await import(built("contacts/dist/domain/outreach/status.js"));
const { approve, skip } = await import(built("approvals/dist/domain/items/decide.js"));
const { attachStepDraft } = await import(built("approvals/dist/testing/index.js"));
const { writeMessageDraft } = await import(built("messaging/dist/testing/index.js"));
const { holdForReply } = await import(built("campaigns/dist/index.js"));
const campaigns = await import(built("campaigns/dist/testing/index.js"));
const { nextDueAt } = await import(built("campaigns/dist/domain/template/due.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
tenancy.useTenancyClient(app);
const log = platform.createLogger({ destination: platform.collectLogs().destination });
const loaded = await loadModules(
  moduleLoaders.filter(({ name }) => name === "campaigns" || name === "messaging"),
);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: app, log })];
  }),
);
/** Every start the tick and the subscribers ask for, recorded; none runs. */
const starts: WorkflowStart[] = [];
platform.bindWorkflowStarter({
  start: async (request) => {
    starts.push(request);
    return { started: true };
  },
});

const APPROVER = "usr_campaigns_approver";
const DAY_MS = 86_400_000;
const FIRST = "Noor, how does your team follow up on warm leads today?";
const NONE = { opened: 0, passedOver: 0, noSender: 0, failed: 0 };
const approver: Principal = {
  userId: APPROVER,
  actorType: "human",
  authMethod: "session",
  scopes: [],
};
const service = platform.servicePrincipal("campaigns_test");
const inRun = <T>(
  workspaceId: string,
  principal: Principal,
  fn: (tx: TenantClient) => Promise<T>,
) => withTenant({ workspaceId, principal }, fn, { client: app });

/** The first truthy answer of `probe`, asked every 50 ms for 20 seconds at most. */
async function until<T>(probe: () => Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const answer = await probe();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error("until: no answer in 20 seconds");
    await sleep(50);
  }
}

/** The worker's outbox loop, run until every event is delivered, then stopped. */
async function deliver(): Promise<void> {
  const loop = startOutboxLoop(app, log);
  try {
    await until(async () => (await app.outboxEntry.count({ where: { deliveredAt: null } })) === 0);
  } finally {
    await loop.stop();
  }
}

/** A workspace with the approver's connected account, in UTC. */
async function workspaceWithAccount(): Promise<string> {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  await linkedin.createConnectedAccount(workspace.id, { ownerUserId: APPROVER });
  return workspace.id;
}

/** A person approved by the approver and enrolled by campaigns' subscriber: its id. */
async function enrolled(workspaceId: string, slug: string): Promise<string> {
  const personId: string = await inRun(workspaceId, service, async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await contacts.upsertPersonFromSource({
      ...{ source: "import", provider: "csv", profile },
    });
    const source = { kind: "imported", ref: "imp_1" };
    await contacts.createLeadForPerson({ personId: person.id, source });
    return person.id;
  });
  await inRun(workspaceId, approver, () => approveLead(personId));
  await deliver();
  return personId;
}

const queueRun = (workspaceId: string) =>
  runWorkflow("campaigns_queue", { workspaceId }, { activities });
const stepsOf = (personId: string) =>
  app.stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } });
const itemsOf = (personId: string) =>
  app.approvalItem.findMany({
    where: { personId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
const itemOf = (stepExecutionId: string) =>
  app.approvalItem.findFirstOrThrow({ where: { stepExecutionId } });
/** The person's messaging.draft_requested payloads, oldest first: as whom, from which drafts. */
const requests = async (personId: string) =>
  (
    await app.outboxEntry.findMany({
      where: { eventName: "messaging.draft_requested" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  )
    .map(
      ({ payload }) => payload as { personId: string; userId: string; earlierDraftIds: string[] },
    )
    .filter((payload) => payload.personId === personId)
    .map(({ userId, earlierDraftIds }) => ({ userId, earlierDraftIds }));
/** The step's message written as the writer leaves it, and attached to its item as on its event. */
async function written(stepExecutionId: string, text: string): Promise<void> {
  const { draftId } = await itemOf(stepExecutionId);
  const draft = await app.messageDraft.findFirstOrThrow({ where: { stepExecutionId } });
  assert.equal(draftId, null, "a message's item waits for its draft");
  assert.equal(await writeMessageDraft(draft.id, { status: "ready", text }, app), 1);
  assert.equal(await attachStepDraft({ draftId: draft.id, stepExecutionId }, app), 1);
}
/** Approve and Skip in "Up next", as their routes run them: the approver's run. */
const approveItem = (workspaceId: string, itemId: string) =>
  inRun(workspaceId, approver, () => approve(itemId, {}, approver));
const skipItem = (workspaceId: string, itemId: string) =>
  inRun(workspaceId, approver, () => skip(itemId, approver));
/** As the sender (beta-p4-020) and the acceptance (beta-p4-050) will leave the steps. */
const sent = (id: string) =>
  app.stepExecution.update({ where: { id }, data: { status: "succeeded" } });
const dueNow = (id: string) =>
  app.stepExecution.update({ where: { id }, data: { dueAt: new Date() } });

test("the schedule campaigns.queue starts the tick every 15 minutes; the tick starts each workspace's campaigns_queue for its slot, one at a time by campaigns.queue:<workspace>:<slot>", async () => {
  const schedule = loaded.schedules.find(({ id }) => id === "campaigns.queue");
  assert.deepEqual(schedule, {
    id: "campaigns.queue",
    workflow: "campaigns_queue_tick",
    spec: { intervals: [{ every: "15 minutes" }] },
    input: {},
  });
  const [a, b] = await tenancy.createTwoWorkspaces();
  starts.length = 0;
  // 10:07 UTC: the slot that starts at 10:00.
  campaigns.useClock(() => new Date("2026-10-29T10:07:00Z"));
  try {
    const counts = await runWorkflow("campaigns_queue_tick", {}, { activities });
    assert.deepEqual(counts, { workspaces: 2, started: 2 });
  } finally {
    campaigns.useClock(undefined);
  }
  const expected = [a.workspace.id, b.workspace.id].sort().map((workspaceId) => ({
    workflow: "campaigns_queue",
    input: { workspaceId },
    workflowId: `campaigns.queue:${workspaceId}:20261029T1000Z`,
    oneAtATime: true,
  }));
  assert.deepEqual(starts, expected);
});

test("the first run opens the connection request's item with its empty note, and the step awaits approval with it; the next day's run keeps the item and its draft and opens nothing", async () => {
  const workspaceId = await workspaceWithAccount();
  const personId = await enrolled(workspaceId, "queue-first-run");
  assert.deepEqual(await queueRun(workspaceId), { ...NONE, opened: 1 });
  const [connect, ...later] = await stepsOf(personId);
  const [item, ...more] = await itemsOf(personId);
  assert.ok(connect && item);
  assert.deepEqual(more, []);
  assert.deepEqual([connect.status, connect.approvalItemId], ["awaiting_approval", item.id]);
  assert.deepEqual(
    [item.status, item.stepKey, item.actionType, item.scheduledFor],
    ["pending", "connect", "invite", connect.dueAt],
  );
  assert.deepEqual(
    later.map(({ status }) => status),
    ["planned", "planned", "planned"],
  );
  const note = await app.messageDraft.findUniqueOrThrow({ where: { id: item.draftId ?? "" } });
  assert.deepEqual([note.channel, note.status, note.text], ["linkedin_note", "ready", ""]);
  await deliver();

  // A day later the item waits still: the run lists planned steps only.
  campaigns.useClock(() => new Date(Date.now() + DAY_MS));
  try {
    assert.deepEqual(await queueRun(workspaceId), NONE);
  } finally {
    campaigns.useClock(undefined);
  }
  const [kept] = await stepsOf(personId);
  assert.deepEqual([kept?.status, kept?.approvalItemId], ["awaiting_approval", item.id]);
  assert.deepEqual(await itemsOf(personId), [item]);
});

test("approve and skip through approvals' commands: the step scheduled with its draft; a message's draft asked as the owner from the drafts already sent; a follow-up skipped makes the next due five business days after the skip", async () => {
  const workspaceId = await workspaceWithAccount();
  const personId = await enrolled(workspaceId, "queue-decisions");
  await queueRun(workspaceId);
  const [connect, message1, followUp1, followUp2] = await stepsOf(personId);
  assert.ok(connect && message1 && followUp1 && followUp2);
  // A bare Approve, as "Up next" sends it: the note as drafted, empty.
  const connectItem = await itemOf(connect.id);
  await approveItem(workspaceId, connectItem.id);
  await deliver();
  const scheduled = await app.stepExecution.findUniqueOrThrow({ where: { id: connect.id } });
  assert.deepEqual([scheduled.status, scheduled.draftId], ["scheduled", connectItem.draftId]);

  await sent(connect.id);
  await dueNow(message1.id);
  assert.deepEqual(await queueRun(workspaceId), { ...NONE, opened: 1 });
  await written(message1.id, FIRST);
  const message1Item = await itemOf(message1.id);
  await approveItem(workspaceId, message1Item.id);
  await deliver();
  assert.equal(
    (await app.stepExecution.findUniqueOrThrow({ where: { id: message1.id } })).status,
    "scheduled",
  );
  await sent(message1.id);
  await dueNow(followUp1.id);
  assert.deepEqual(await queueRun(workspaceId), { ...NONE, opened: 1 });
  await deliver();
  assert.deepEqual(await requests(personId), [
    { userId: APPROVER, earlierDraftIds: [connectItem.draftId] },
    { userId: APPROVER, earlierDraftIds: [connectItem.draftId, message1Item.draftId] },
  ]);
  // Each request started messaging's writer for its draft, recorded and not run here.
  const where = { stepExecutionId: followUp1.id };
  const followUp1Draft = await app.messageDraft.findFirstOrThrow({ where });
  const writers = starts.filter(({ workflow }) => workflow === "messaging_draft_message");
  assert.deepEqual(
    writers.map(({ workflowId }) => workflowId),
    [message1Item.draftId, followUp1Draft.id].map((id) => `messaging.draft:${workspaceId}:${id}`),
  );

  const followUp1Item = await itemOf(followUp1.id);
  await skipItem(workspaceId, followUp1Item.id);
  await deliver();
  const skipped = await app.stepExecution.findUniqueOrThrow({ where: { id: followUp1.id } });
  assert.deepEqual([skipped.status, skipped.skipReason], ["skipped", "skipped_by_owner"]);
  const { decidedAt } = await itemOf(followUp1.id);
  assert.ok(decidedAt);
  const next = await app.stepExecution.findUniqueOrThrow({ where: { id: followUp2.id } });
  assert.deepEqual(
    [next.status, next.dueAt],
    ["planned", nextDueAt("follow_up_2", decidedAt, "UTC")],
  );
  const enrollment = await app.enrollment.findUniqueOrThrow({
    where: { id: connect.enrollmentId },
  });
  assert.equal(enrollment.status, "active");
});

test("a reply's hold blocks the pending item in its transaction: a late Approve answers 409 approval_item_not_pending, and the step stays held", async () => {
  const workspaceId = await workspaceWithAccount();
  const personId = await enrolled(workspaceId, "queue-held");
  await queueRun(workspaceId);
  const [connect] = await stepsOf(personId);
  assert.ok(connect);
  const item = await itemOf(connect.id);
  await inRun(workspaceId, service, () => holdForReply(personId, { at: new Date() }));
  assert.equal((await itemOf(connect.id)).status, "blocked");
  await assert.rejects(approveItem(workspaceId, item.id), (error: unknown) => {
    const { code, status } = error as { code?: string; status?: number };
    return code === "approval_item_not_pending" && status === 409;
  });
  await deliver();
  const held = await app.stepExecution.findUniqueOrThrow({ where: { id: connect.id } });
  assert.deepEqual([held.status, held.skipReason], ["held", "replied"]);
  assert.equal(await app.outboxEntry.count({ where: { eventName: "approvals.item_decided" } }), 0);
});
